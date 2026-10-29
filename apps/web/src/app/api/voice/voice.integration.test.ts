import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
const state = vi.hoisted(() => ({ database: null as unknown, ctx: {
  workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "editor", correlationId: "test",
} }));
vi.mock("@/lib/services", () => ({ db: () => state.database }));
vi.mock("@ob/db", async original => {
  const module = await original<typeof import("@ob/db")>();
  return { ...module, repo: { ...module.repo, writeAudit: vi.fn() } };
});
vi.mock("@/lib/api", () => ({
  route: (handler: Function) => (req: Request) => handler(state.ctx, req),
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()),
}));
import { PATCH } from "./route";
import { repo, type Database } from "@ob/db";
let pg: PGlite;
const voiceId = "33333333-3333-4333-8333-333333333333";
const businessId = "44444444-4444-4444-8444-444444444444";
const edit = (id: string, terms: string[]): Promise<any> => PATCH(new Request("http://localhost/api/voice", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: id, bannedTerms: terms }),
}));
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE businesses (id uuid PRIMARY KEY, workspace_id uuid);
    CREATE TABLE brand_voices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, business_id uuid,
      version integer, profile jsonb, banned_terms jsonb DEFAULT '[]', preferred_terms jsonb DEFAULT '[]',
      samples jsonb DEFAULT '[]', approved_at timestamptz, approved_by uuid, is_active boolean DEFAULT false,
      created_at timestamptz DEFAULT now(), UNIQUE(business_id,version)
    );
    INSERT INTO businesses VALUES ('${businessId}','${state.ctx.workspaceId}');
  `);
  state.database = drizzle(pg);
}, 30000);
beforeEach(async () => {
  state.ctx.role = "editor";
  await pg.exec("DELETE FROM brand_voices");
  await pg.query("INSERT INTO brand_voices (id,workspace_id,business_id,version,profile,banned_terms,is_active,approved_at,approved_by) VALUES ($1,$2,$3,1,$4,$5,true,now(),$6)",
    [voiceId, state.ctx.workspaceId, businessId, { tone: ["friendly"] }, ["old"], state.ctx.userId]);
});
afterAll(async () => pg?.close());

it("preserves an approved voice and creates an inactive draft for edits", async () => {
  const result = await edit(voiceId, ["new"]);
  expect(result.voice).toMatchObject({ version: 2, isActive: false, approvedAt: null });
  expect(result.voice.id).not.toBe(voiceId);
  const { rows } = await pg.query<{ id: string; banned_terms: string[]; is_active: boolean }>("SELECT id,banned_terms,is_active FROM brand_voices ORDER BY version");
  expect(rows[0]).toEqual({ id: voiceId, banned_terms: ["old"], is_active: true });
  expect(rows[1]!.banned_terms).toEqual(["new"]);
});

it("updates an unapproved draft without replacing the approved version", async () => {
  const created = await edit(voiceId, ["first"]);
  const updated = await edit(created.voice.id, ["second"]);
  expect(updated.voice.id).toBe(created.voice.id);
  expect((await pg.query("SELECT * FROM brand_voices")).rows).toHaveLength(2);
});

it("activates a new draft while retaining exactly one active voice", async () => {
  const created = await edit(voiceId, ["new"]);
  await repo.activateVoice(state.database as Database, { ...state.ctx, role: "admin" }, created.voice.id);
  const { rows } = await pg.query<{ id: string }>("SELECT id FROM brand_voices WHERE is_active");
  expect(rows).toEqual([{ id: created.voice.id }]);
});

it("rejects edits from viewers and other workspaces", async () => {
  state.ctx.role = "viewer";
  await expect(edit(voiceId, ["bad"])).rejects.toThrow(/editor role/);
  state.ctx.role = "editor";
  const originalWorkspace = state.ctx.workspaceId;
  state.ctx.workspaceId = "55555555-5555-4555-8555-555555555555";
  try { await expect(edit(voiceId, ["bad"])).rejects.toThrow(/could not be found/); }
  finally { state.ctx.workspaceId = originalWorkspace; }
});
