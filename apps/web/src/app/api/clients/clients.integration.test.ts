import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { users, workspaces, businesses, businessSources, articles } from "@ob/db";

/**
 * Adding, switching and removing a client, against a real schema.
 *
 * These paths touch three tables and a queue, and the parts that go wrong are
 * the ones a unit test cannot see: that the profile typed into the add form is
 * actually stored, that starter instructions are written at insert time, that
 * selecting a client survives a round trip, and that removing one is refused
 * while it still has work attached.
 *
 * Against the migrated schema rather than a mock, because the failures worth
 * catching here are schema failures — a column that does not exist, a default
 * that is not applied, a constraint that fires.
 */

const state = vi.hoisted(() => ({
  database: null as unknown,
  enqueue: vi.fn().mockResolvedValue("test-job"),
  ctx: {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "owner",
    correlationId: "test",
  },
}));

vi.mock("@/lib/services", () => ({
  db: () => state.database,
  getQueues: () => ({ enqueue: state.enqueue }),
}));
vi.mock("@/lib/api", () => ({
  route: (handler: Function) => (req: Request) => handler(state.ctx, req),
  parseBody: async (req: Request, schema: { parse: Function }) =>
    schema.parse(await req.json()),
}));

import { POST as addClient, PATCH as selectClient, DELETE as removeClient, GET as listClients } from "./route";

let pg: PGlite;
let database: ReturnType<typeof drizzle>;

const request = (body?: unknown, method = "POST") =>
  new Request("http://localhost/api/clients", {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
const call = async (handler: Function, body?: unknown, method = "POST"): Promise<any> =>
  handler(request(body, method));

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
  await pg.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  const dir = "packages/db/migrations";
  const all = (await readdir(dir)).filter((f) => f.endsWith(".sql"));
  const ordered = [
    ...all.filter((f) => f.startsWith("pre_")).sort(),
    ...all.filter((f) => !f.startsWith("pre_") && !f.startsWith("post_")).sort(),
    ...all.filter((f) => f.startsWith("post_")).sort(),
  ];
  for (const file of ordered) {
    if (file.startsWith("pre_")) continue;
    await pg.exec(await readFile(`${dir}/${file}`, "utf8"));
  }

  database = drizzle(pg);
  state.database = database;
  await database.insert(users).values({
    id: state.ctx.userId, email: "qa@example.com",
    emailNormalized: "qa@example.com", authProvider: "email",
  });
  await database.insert(workspaces).values({
    id: state.ctx.workspaceId, ownerId: state.ctx.userId, name: "QA", slug: "qa",
  });
}, 30000);

afterAll(async () => { await pg?.close(); });

describe.sequential("adding a client", () => {
  it("stores the profile typed into the add form", async () => {
    const res = await call(addClient, {
      name: "Stadium Pharmacy",
      websiteUrl: "stadiumrx.com",
      industry: "Pharmacy",
      audience: "Patients collecting prescriptions",
      description: "A neighbourhood pharmacy.",
      usp: "Free same-day delivery",
      primaryCta: "Call to transfer a prescription",
      gmbName: "Stadium Pharmacy Inc",
    });

    const [row] = await database.select().from(businesses)
      .where(eq(businesses.id, res.businessId));

    expect(row!.industry).toBe("Pharmacy");
    expect(row!.audience).toBe("Patients collecting prescriptions");
    expect(row!.usp).toBe("Free same-day delivery");
    expect(row!.gmbName).toBe("Stadium Pharmacy Inc");
    // A bare domain must be normalised, as the onboarding path does.
    expect(row!.websiteUrl).toBe("https://stadiumrx.com/");
  });

  it("writes starter instructions at insert time", async () => {
    /*
     * The whole point of collecting the profile in the add form: a client
     * arrives with instructions rather than six empty boxes. Checked here
     * rather than in a unit test because it is the insert that has to carry
     * them, and `prompts` has a NOT NULL default that would quietly win.
     */
    const [row] = await database.select().from(businesses)
      .where(eq(businesses.name, "Stadium Pharmacy"));

    expect(row!.prompts.blog?.topics).toContain("Patients collecting prescriptions");
    expect(row!.prompts.blog?.article).toContain("Free same-day delivery");
    expect(row!.prompts.social?.post!.length).toBeGreaterThan(80);
    // Pharmacy gets its named caution.
    expect(row!.prompts.blog?.article).toContain("dosing advice");
  });

  it("queues a crawl and selects the new client", async () => {
    expect(state.enqueue).toHaveBeenCalled();
    const [source] = await database.select().from(businessSources);
    expect(source!.crawlStatus).toBe("pending");

    const listed = await call(listClients, undefined, "GET");
    const [row] = await database.select().from(businesses);
    expect(listed.selectedId).toBe(row!.id);
  });

  it("accepts a client with no website and no details", async () => {
    // The manual path: nothing to crawl, so the name is all there is.
    const res = await call(addClient, { name: "Manual Client" });
    const [row] = await database.select().from(businesses)
      .where(eq(businesses.id, res.businessId));

    expect(row!.websiteUrl).toBeNull();
    expect(res.crawlStatus).toBe("manual");
    // Still gets instructions, thin but real.
    expect(row!.prompts.blog?.topics).toContain("Manual Client");
  });

  it("refuses a duplicate name", async () => {
    await expect(call(addClient, { name: "Manual Client" }))
      .rejects.toThrow("already exists");
  });

  it("treats a blank optional field as not given", async () => {
    // An empty box must not store "", which would then block the crawl from
    // seeding that field.
    const res = await call(addClient, {
      name: "Blank Fields", industry: "   ", audience: "",
    });
    const [row] = await database.select().from(businesses)
      .where(eq(businesses.id, res.businessId));
    expect(row!.industry).toBeNull();
    expect(row!.audience).toBeNull();
  });
});

describe.sequential("switching client", () => {
  it("survives a round trip", async () => {
    const rows = await database.select().from(businesses);
    const target = rows.find((r) => r.name === "Stadium Pharmacy")!;

    await call(selectClient, { businessId: target.id }, "PATCH");
    const listed = await call(listClients, undefined, "GET");
    expect(listed.selectedId).toBe(target.id);
  });

  it("refuses a client from another workspace", async () => {
    await expect(call(selectClient, {
      businessId: "33333333-3333-4333-8333-333333333333",
    }, "PATCH")).rejects.toThrow();
  });
});

describe.sequential("removing a client", () => {
  it("refuses while the client still has articles", async () => {
    /*
     * The cascade would take the articles with it and there is no undo.
     * Requiring them to go first makes the loss explicit rather than a side
     * effect of tidying a list.
     */
    const [target] = await database.select().from(businesses)
      .where(eq(businesses.name, "Blank Fields"));

    await database.insert(articles).values({
      workspaceId: state.ctx.workspaceId,
      businessId: target!.id,
      title: "A draft", slug: "a-draft", status: "draft",
    });

    await expect(call(removeClient, { businessId: target!.id }, "DELETE"))
      .rejects.toThrow(/1 article/);
  });

  it("removes a client that has no work attached", async () => {
    const [target] = await database.select().from(businesses)
      .where(eq(businesses.name, "Manual Client"));

    await call(removeClient, { businessId: target!.id }, "DELETE");

    const remaining = await database.select().from(businesses)
      .where(eq(businesses.id, target!.id));
    expect(remaining).toHaveLength(0);
  });

  it("clears the selection when the selected client is removed", async () => {
    /*
     * The selected client is a JSON pointer in workspace settings, not a
     * foreign key, so nothing cascades it. Left dangling it named a row that
     * no longer existed, and the layout handed that id to the crawl poller
     * and the switcher — which then computed the highlighted row and the
     * "already selected" guard against a fallback rather than a selection.
     */
    const res = await call(addClient, { name: "Doomed Client" });
    let listed = await call(listClients, undefined, "GET");
    expect(listed.selectedId).toBe(res.businessId);

    await call(removeClient, { businessId: res.businessId }, "DELETE");

    const [ws] = await database.select().from(workspaces)
      .where(eq(workspaces.id, state.ctx.workspaceId));
    expect(ws!.settings.onboarding?.businessId).toBeUndefined();

    // And the list falls back to a client that actually exists.
    listed = await call(listClients, undefined, "GET");
    const alive = await database.select().from(businesses);
    expect(alive.map((b) => b.id)).toContain(listed.selectedId);
  });

  it("does not disturb the selection when another client is removed", async () => {
    const keep = await call(addClient, { name: "Keep Me" });
    const other = await call(addClient, { name: "Remove Me" });

    // Select the one we are keeping, then delete the other.
    await call(selectClient, { businessId: keep.businessId }, "PATCH");
    await call(removeClient, { businessId: other.businessId }, "DELETE");

    const listed = await call(listClients, undefined, "GET");
    expect(listed.selectedId).toBe(keep.businessId);
  });
});
