import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import {
  users, workspaces, workspaceMembers, workspaceTeamMembers, workspaceInvites, businesses, articles, articleReviews, qualityGateResults,
} from "@ob/db";

const state = vi.hoisted(() => ({ database: null as any, enqueue: vi.fn().mockResolvedValue("job"),
  ctx: { workspaceId: "", userId: "", role: "owner", correlationId: "test" } as { workspaceId: string; userId: string; role: string; correlationId: string } }));
vi.mock("@/lib/services", () => ({ db: () => state.database, getQueues: () => ({ enqueue: state.enqueue }) }));
vi.mock("@/lib/api", () => ({
  route: (handler: Function) => (req: Request) => handler({ ...state.ctx }, req),
  publicRoute: (handler: Function) => (req: Request) => handler(req),
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()),
}));

import { GET as getTeam, PATCH as patchTeam } from "./route";
import { POST as approve } from "../articles/[id]/approve/route";
import { POST as publish } from "../articles/[id]/publish/route";
import { acceptInviteAsMember, acceptInviteAsNewUser, createInvite, findInvite, hashInviteToken, revokeInvite } from "@/lib/invites";
import { isMissingTable, loadTeamSetup } from "@/lib/team-review-server";

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
const workspaceId = randomUUID();
const people = { owner: randomUUID(), writer: randomUUID(), boss: randomUUID(), poster: randomUUID(), viewer: randomUUID() };
let businessId: string;

const as = (who: keyof typeof people, role: string) => { state.ctx = { workspaceId, userId: people[who], role, correlationId: "test" }; };
const json = (url: string, method: string, body: unknown) => new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const decide = (id: string, decision: string, version = 1, note?: string) =>
  approve(json(`http://localhost/api/articles/${id}/approve`, "POST", { expectedVersion: version, decision, ...(note ? { note } : {}) }));
const setTeams = (who: keyof typeof people, teams: string[]) => patchTeam(json("http://localhost/api/team", "PATCH", { userId: people[who], teams }));
const setProcess = (reviewProcess: string) => patchTeam(json("http://localhost/api/team", "PATCH", { reviewProcess }));
const articleStatus = async (id: string) => (await database.select({ status: articles.status }).from(articles).where(eq(articles.id, id)))[0]!.status;
const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as { code: string; message: string }; } throw new Error("expected a failure"); };
const createArticle = async () => {
  const [row] = await database.insert(articles).values({ workspaceId, businessId, title: "Care at home", slug: randomUUID(), status: "awaiting_approval",
    version: 1, seoScore: 90, bodyMarkdown: "## Care\n\nHelpful text." } as any).returning();
  await database.insert(qualityGateResults).values({ workspaceId, articleId: row!.id, articleVersion: 1, gate: "seo", verdict: "pass", findings: [] } as any);
  return row!;
};

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  const dir = "packages/db/migrations";
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql") && !f.startsWith("pre_"));
  for (const file of [...files.filter(f => !f.startsWith("post_")).sort(), ...files.filter(f => f.startsWith("post_")).sort()]) {
    await pg.exec(await readFile(`${dir}/${file}`, "utf8"));
  }
  database = drizzle(pg); state.database = database;
  for (const [key, id] of Object.entries(people)) {
    await database.insert(users).values({ id, email: `${key}@agency.example`, emailNormalized: `${key}@agency.example`, name: key[0]!.toUpperCase() + key.slice(1) });
  }
  await database.insert(workspaces).values({ id: workspaceId, ownerId: people.owner, name: "Agency", slug: "agency" });
  await database.insert(workspaceMembers).values([
    { workspaceId, userId: people.owner, role: "owner" }, { workspaceId, userId: people.writer, role: "editor" },
    { workspaceId, userId: people.boss, role: "editor" }, { workspaceId, userId: people.poster, role: "editor" },
    { workspaceId, userId: people.viewer, role: "viewer" },
  ]);
  businessId = (await database.insert(businesses).values({ workspaceId, name: "Care", websiteUrl: "https://care.example" }).returning())[0]!.id;
}, 30000);
afterAll(async () => { await pg?.close(); });

describe.sequential("setting up the team review", () => {
  it("refuses to switch on team review before every team has someone", async () => {
    as("owner", "owner");
    expect(await failure(setProcess("team"))).toMatchObject({ code: "validation_failed", message: expect.stringContaining("Content team, Managers") });
  });

  it("puts people on teams, but never a viewer", async () => {
    as("owner", "owner");
    await setTeams("writer", ["content"]);
    await setTeams("boss", ["manager"]);
    expect(await failure(setTeams("viewer", ["content"]))).toMatchObject({ code: "validation_failed" });
    const team = await getTeam(new Request("http://localhost/api/team")) as any;
    expect(team.members.find((m: any) => m.id === people.writer).teams).toEqual(["content"]);
    expect(team.available).toBe(true);
  });

  it("lets an editor neither see the team settings nor switch the process", async () => {
    as("writer", "editor");
    expect(await failure(getTeam(new Request("http://localhost/api/team")))).toMatchObject({ code: "forbidden" });
    expect(await failure(setProcess("team"))).toMatchObject({ code: "forbidden" });
  });

  it("switches team review on once each team has someone", async () => {
    as("owner", "owner");
    expect(await setProcess("team")).toMatchObject({ ok: true, reviewProcess: "team" });
    const [row] = await database.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(row!.settings).toMatchObject({ reviewProcess: "team" });
  });
});

describe.sequential("an article through the three levels", () => {
  let id: string;
  beforeAll(async () => { id = (await createArticle()).id; });

  it("waits for the Content team first: a Manager cannot skip it", async () => {
    as("boss", "editor");
    expect(await failure(decide(id, "approve"))).toMatchObject({ code: "forbidden", message: expect.stringContaining("Content team (Writer)") });
  });

  it("records the Content team's approval and moves it to the Manager, without approving the article", async () => {
    as("writer", "editor");
    expect(await decide(id, "approve")).toMatchObject({ ok: true, stage: "manager" });
    expect(await articleStatus(id)).toBe("awaiting_approval");
    const rows = await database.select().from(articleReviews).where(eq(articleReviews.articleId, id));
    expect(rows).toMatchObject([{ step: "content", decision: "approved", userId: people.writer, articleVersion: 1 }]);
  });

  it("does not let the Content team give the final approval too", async () => {
    as("writer", "editor");
    expect(await failure(decide(id, "approve"))).toMatchObject({ code: "forbidden", message: expect.stringContaining("Managers (Boss)") });
  });

  it("lets the Manager send it back, which sends it to the Content team again", async () => {
    as("boss", "editor");
    expect(await decide(id, "request_changes", 1, "Add the costs section.")).toMatchObject({ status: "needs_changes" });
    // Quality checks run again on the same version: the earlier content approval no longer counts.
    await database.update(articles).set({ status: "awaiting_approval" }).where(eq(articles.id, id));
    expect(await failure(decide(id, "approve"))).toMatchObject({ code: "forbidden", message: expect.stringContaining("Content team") });
  });

  it("is approved only by the Manager after the Content team approves again", async () => {
    as("writer", "editor");
    await decide(id, "approve");
    as("boss", "editor");
    expect(await decide(id, "approve")).toMatchObject({ ok: true, status: "approved" });
    expect(await articleStatus(id)).toBe("approved");
    const steps = (await database.select().from(articleReviews).where(eq(articleReviews.articleId, id))).map((r) => `${r.step}:${r.decision}`);
    expect(steps).toEqual(["content:approved", "manager:changes_requested", "content:approved", "manager:approved"]);
  });

  it("lets the Content team or a Manager send it to WordPress, but nobody off the teams, even the owner", async () => {
    const send = () => publish(json(`http://localhost/api/articles/${id}/publish`, "POST", { provider: "wordpress" }));
    as("owner", "owner");
    expect(await failure(send())).toMatchObject({ code: "forbidden", message: expect.stringContaining("Content team and Managers (Writer, Boss)") });
    as("poster", "editor");
    expect(await failure(send())).toMatchObject({ code: "forbidden" });
    // Past the permission check, it stops only because this test workspace has no WordPress connection.
    for (const who of ["writer", "boss"] as const) {
      as(who, "editor");
      expect(await failure(send())).toMatchObject({ code: "validation_failed", message: expect.stringContaining("No wordpress connection") });
    }
  });

  it("keeps the single reviewer working exactly as before when switched back", async () => {
    as("owner", "owner");
    await setProcess("single");
    const other = await createArticle();
    as("writer", "editor");
    expect(await decide(other.id, "approve")).toMatchObject({ ok: true, status: "approved" });
    expect(await database.select().from(articleReviews).where(eq(articleReviews.articleId, other.id))).toHaveLength(0);
    as("poster", "editor");
    expect(await failure(publish(json(`http://localhost/api/articles/${other.id}/publish`, "POST", { provider: "wordpress" }))))
      .toMatchObject({ code: "forbidden" });
  });
});

describe.sequential("teammate invites", () => {
  const ownerCtx = () => ({ workspaceId, userId: people.owner, role: "owner" as const, correlationId: "test" });

  it("creates a one-time link for a new teammate, storing only its hash", async () => {
    const { token, invite } = await createInvite(database as any, ownerCtx(), { email: "New.Writer@Agency.example", role: "editor", teams: ["content", "content"] });
    expect(invite.teams).toEqual(["content"]);
    const [row] = await database.select().from(workspaceInvites).where(eq(workspaceInvites.id, invite.id));
    expect(row!.tokenHash).toBe(hashInviteToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await findInvite(database as any, token)).toMatchObject({ state: "pending", workspaceName: "Agency", email: "New.Writer@Agency.example", invitedByName: "Owner" });
  });

  it("refuses invites an admin should not make", async () => {
    const adminCtx = { ...ownerCtx(), userId: people.boss, role: "admin" as const };
    expect(await failure(createInvite(database as any, adminCtx, { email: "x@agency.example", role: "admin", teams: [] }))).toMatchObject({ code: "forbidden" });
    expect(await failure(createInvite(database as any, ownerCtx(), { email: "y@agency.example", role: "viewer", teams: ["manager"] }))).toMatchObject({ code: "validation_failed" });
    expect(await failure(createInvite(database as any, ownerCtx(), { email: "WRITER@agency.example", role: "editor", teams: [] }))).toMatchObject({ code: "conflict" });
  });

  it("creates the account inside the workspace, with the invite's role and teams, and works only once", async () => {
    const { token } = await createInvite(database as any, ownerCtx(), { email: "joiner@agency.example", role: "editor", teams: ["content", "manager"] });
    const joined = await acceptInviteAsNewUser(database as any, { token, name: "Joiner", passwordHash: "hash" });
    expect(joined.workspaceId).toBe(workspaceId);
    const [member] = await database.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, joined.userId)));
    expect(member!.role).toBe("editor");
    const teams = (await database.select().from(workspaceTeamMembers).where(eq(workspaceTeamMembers.userId, joined.userId))).map((r) => r.team).sort();
    expect(teams).toEqual(["content", "manager"]);
    expect(await database.select().from(workspaces).where(eq(workspaces.ownerId, joined.userId))).toHaveLength(0);
    expect(await failure(acceptInviteAsNewUser(database as any, { token, name: "Again", passwordHash: "hash" }))).toMatchObject({ code: "conflict" });
  });

  it("retires the older link when a new invite is made for the same address", async () => {
    const first = await createInvite(database as any, ownerCtx(), { email: "twice@agency.example", role: "editor", teams: [] });
    const second = await createInvite(database as any, ownerCtx(), { email: "twice@agency.example", role: "editor", teams: [] });
    expect((await findInvite(database as any, first.token))!.state).toBe("revoked");
    expect((await findInvite(database as any, second.token))!.state).toBe("pending");
  });

  it("joins an existing account only when signed in as the invited address", async () => {
    const outsider = randomUUID();
    await database.insert(users).values({ id: outsider, email: "freelancer@else.example", emailNormalized: "freelancer@else.example" });
    const { token } = await createInvite(database as any, ownerCtx(), { email: "freelancer@else.example", role: "editor", teams: ["content"] });
    expect(await failure(acceptInviteAsMember(database as any, { token, userId: people.viewer, email: "viewer@agency.example" }))).toMatchObject({ code: "forbidden" });
    expect(await failure(acceptInviteAsNewUser(database as any, { token, name: "Dup", passwordHash: "hash" }))).toMatchObject({ code: "conflict", message: expect.stringContaining("already has a GrowPilot account") });
    expect(await acceptInviteAsMember(database as any, { token, userId: outsider, email: "Freelancer@Else.example" })).toEqual({ workspaceId });
  });

  it("stops expired and revoked links", async () => {
    const expired = await createInvite(database as any, ownerCtx(), { email: "late@agency.example", role: "editor", teams: [] });
    await database.update(workspaceInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(workspaceInvites.id, expired.invite.id));
    expect((await findInvite(database as any, expired.token))!.state).toBe("expired");
    expect(await failure(acceptInviteAsNewUser(database as any, { token: expired.token, name: "Late", passwordHash: "hash" }))).toMatchObject({ code: "conflict" });
    const revoked = await createInvite(database as any, ownerCtx(), { email: "gone@agency.example", role: "editor", teams: [] });
    await revokeInvite(database as any, ownerCtx(), revoked.invite.id);
    expect((await findInvite(database as any, revoked.token))!.state).toBe("revoked");
    expect(await findInvite(database as any, "not-a-real-token-but-long-enough")).toBeNull();
  });
});

describe.sequential("before the database update is applied", () => {
  it("reports the team review as unavailable instead of breaking", async () => {
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable(new Error("wrapped", { cause: { code: "42P01" } }))).toBe(true);
    expect(isMissingTable({ code: "23505" })).toBe(false);
    await database.update(workspaces).set({ settings: { reviewProcess: "team" } }).where(eq(workspaces.id, workspaceId));
    await pg.exec("DROP TABLE workspace_team_members CASCADE;");
    const setup = await loadTeamSetup(database as any, { workspaceId, userId: people.owner, role: "owner", correlationId: "test" });
    expect(setup).toMatchObject({ available: false, process: "single" });
    as("owner", "owner");
    expect(await getTeam(new Request("http://localhost/api/team"))).toMatchObject({ available: false, reviewProcess: "single" });
    expect(await failure(setProcess("team"))).toMatchObject({ code: "dependency_unavailable" });
  });
});
