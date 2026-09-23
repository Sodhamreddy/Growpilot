import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
// pgvector ships as its own package from PGlite 0.5 onward.
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { users, workspaces, businessSources, repo } from "@ob/db";

const state = vi.hoisted(() => ({ database: null as unknown, enqueue: vi.fn().mockResolvedValue("test-job"), ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "test" } }));
vi.mock("@/lib/services", () => ({ db: () => state.database, getQueues: () => ({ enqueue: state.enqueue }) }));
vi.mock("@/lib/api", () => ({ route: (handler: Function) => (req: Request) => handler(state.ctx, req), parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()) }));
import { POST as source, GET as progress } from "./business-source/route";
import { POST as step, PUT as complete } from "./step/route";
import { GET as profile, PATCH as confirm } from "../business/profile/route";

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
const request = (path: string, body?: unknown, method = "POST") => new Request(`http://localhost/api/${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
const call = async (handler: Function, body?: unknown, method = "POST"): Promise<any> => handler(request("test", body, method));

beforeAll(async () => {
  // Both extensions the migrations need: pgvector for embeddings, pg_trgm for
  // the keyword search index. Loading only one made the index migration fail
  // with an error that pointed at the operator class rather than the cause.
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
  await pg.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  /*
   * Apply every migration, in the order the real migrator uses.
   *
   * This used to name two files explicitly, which meant each new migration
   * silently rotted the list: the test schema drifted from the real one and the
   * next unrelated change failed here with "column ... does not exist". Reading
   * the directory keeps the test schema honest by construction.
   */
  const dir = "packages/db/migrations";
  const all = (await readdir(dir)).filter((f) => f.endsWith(".sql"));
  const ordered = [
    ...all.filter((f) => f.startsWith("pre_")).sort(),
    ...all.filter((f) => !f.startsWith("pre_") && !f.startsWith("post_")).sort(),
    ...all.filter((f) => f.startsWith("post_")).sort(),
  ];
  for (const file of ordered) {
    // The extension files are the one thing PGlite handles differently: its
    // vector extension is created above, from the bundled module.
    if (file.startsWith("pre_")) continue;
    await pg.exec(await readFile(`${dir}/${file}`, "utf8"));
  }
  database = drizzle(pg);
  state.database = database;
  await database.insert(users).values({ id: state.ctx.userId, email: "qa@example.com", emailNormalized: "qa@example.com", authProvider: "email" });
  await database.insert(workspaces).values({ id: state.ctx.workspaceId, ownerId: state.ctx.userId, name: "QA", slug: "qa" });
}, 30000);
afterAll(async () => { await pg?.close(); });

describe.sequential("onboarding database integration", () => {
  it("blocks incomplete completion and empty required choices", async () => {
    await expect(call(complete, undefined, "PUT")).rejects.toThrow("Complete the remaining");
    await expect(call(step, { step: "goals", goals: [] })).rejects.toThrow("Choose at least one");
    await call(step, { step: "discovery", heardFrom: "google" });
    await call(step, { step: "goals", goals: ["articles", "social"] });
  });
  it("normalizes a bare domain and reuses a source across retries", async () => {
    const first = await call(source, { source: "website", url: "example.com" });
    const retry = await call(source, { source: "website", url: "https://example.com/" });
    expect(first.sourceId).toBe(retry.sourceId);
    expect(first.businessId).toBe(retry.businessId);
    expect((await database.select().from(businessSources)).length).toBe(1);
    const result = await call(progress, undefined, "GET");
    expect(result.sources[0].url).toBe("https://example.com/");
  });
  it("retries a blocked crawl by resetting the source, not inserting a duplicate", async () => {
    /*
     * The regression: business_sources is unique on (business_id,
     * canonical_url), and the retry path used to insert a fresh row whenever
     * the previous attempt had failed or been blocked. Re-submitting the same
     * URL after a 403 — the single most likely thing a customer does — hit the
     * constraint and surfaced as a generic 500.
     */
    const first = await call(source, { source: "website", url: "retry-example.com" });

    await database
      .update(businessSources)
      .set({ crawlStatus: "blocked", lastError: "That website refused our crawler (HTTP 403)." })
      .where(eq(businessSources.id, first.sourceId));

    const retry = await call(source, { source: "website", url: "retry-example.com" });

    expect(retry.sourceId).toBe(first.sourceId);

    const rows = await database
      .select()
      .from(businessSources)
      .where(eq(businessSources.canonicalUrl, "https://retry-example.com/"));
    expect(rows).toHaveLength(1);

    // Reset so the worker treats it as fresh work, with no stale error shown.
    expect(rows[0]!.crawlStatus).toBe("pending");
    expect(rows[0]!.lastError).toBeNull();
  });

  it("switches to manual profile and persists service area and facts", async () => {
    const manual = { source: "manual", name: "QA Studio", offer: "Website copywriting", audience: "Small businesses", serviceArea: "Hyderabad" };
    const result = await call(source, manual);
    expect(result.nextStep).toBe("confirm");
    const retry = await call(source, manual);
    expect(retry.businessId).toBe(result.businessId);
    const saved = await call(profile, undefined, "GET");
    expect(saved.business.name).toBe("QA Studio");
    expect(saved.locations[0].label).toBe("Hyderabad");
    expect(saved.facts.some((fact: any) => fact.value === manual.offer)).toBe(true);
    expect((await call(progress, undefined, "GET")).sources).toEqual([]);
    state.enqueue.mockClear();
    await call(confirm, { businessId: saved.business.id, name: "QA Studio reviewed", confirm: true }, "PATCH");
    expect(state.enqueue).not.toHaveBeenCalled();
    await call(step, { step: "confirm" });
  });
  it("persists colours, themes, tone and platforms, and starts nothing", async () => {
    await call(step, { step: "colors", brandColors: [{ role: "primary", hex: "#123456" }] });
    await call(step, { step: "pillars", contentPillars: ["education", "authority"], tone: "bold", platforms: ["LinkedIn"] });
    state.enqueue.mockClear();

    await call(complete, undefined, "PUT");

    /*
     * Finishing setup does not start writing.
     *
     * Completion used to queue keyword research, which chained into a content
     * plan, which drafted the top few articles. A customer who had only
     * confirmed their profile arrived at a dashboard holding content they
     * never asked for, already needing changes, each piece having cost a model
     * call. Nothing in this product generates without somebody pressing a
     * button for it.
     */
    expect(state.enqueue).not.toHaveBeenCalled();

    const [workspace] = await database.select().from(workspaces).where(eq(workspaces.id, state.ctx.workspaceId));
    expect(workspace?.onboardingCompletedAt).not.toBeNull();
    expect(workspace?.settings.onboarding).toMatchObject({ heardFrom: "google", tone: "bold", platforms: ["LinkedIn"], brandColors: [{ role: "primary", hex: "#123456" }] });
  });
});
