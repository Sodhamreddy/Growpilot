import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
const state = vi.hoisted(() => ({ database: null as unknown, ctx: {
  workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "test",
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
import { GET, PATCH } from "./route";
const editor = "33333333-3333-4333-8333-333333333333";
const outsider = "44444444-4444-4444-8444-444444444444";
let pg: PGlite;
const change = (userId: string, role: string): Promise<any> => PATCH(new Request("http://localhost/api/team", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, role }),
}));
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, email text, name text);
    CREATE TABLE workspaces (id uuid PRIMARY KEY, owner_id uuid);
    CREATE TABLE workspace_members (workspace_id uuid, user_id uuid, role text, selected_business_id uuid, created_at timestamptz DEFAULT now());
    INSERT INTO users VALUES ('${state.ctx.userId}','owner@example.com','Owner'),('${editor}','editor@example.com','Editor'),('${outsider}','private@example.com','Outsider');
    INSERT INTO workspaces VALUES ('${state.ctx.workspaceId}','${state.ctx.userId}');
    INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('${state.ctx.workspaceId}','${state.ctx.userId}','owner'),('${state.ctx.workspaceId}','${editor}','editor'),('${outsider}','${outsider}','owner');
  `);
  state.database = drizzle(pg);
}, 30000);
beforeEach(() => { state.ctx.role = "owner"; });
afterAll(async () => pg?.close());
it("lists only this workspace's members", async () => {
  const result: any = await GET(new Request("http://localhost/api/team"));
  expect(result.members).toHaveLength(2);
  expect(result.members.some((m: { id: string }) => m.id === outsider)).toBe(false);
});
it("allows the owner to update an existing member", async () => {
  await change(editor, "viewer");
  expect((await pg.query<{ role: string }>("SELECT role FROM workspace_members WHERE user_id=$1", [editor])).rows[0]!.role).toBe("viewer");
});
it("prevents admins from granting privileges and editors from viewing members", async () => {
  state.ctx.role = "admin";
  await expect(change(editor, "admin")).rejects.toThrow(/owner role/);
  state.ctx.role = "editor";
  await expect(GET(new Request("http://localhost/api/team"))).rejects.toThrow(/admin role/);
});
it("preserves the owner and refuses other-workspace identities", async () => {
  await expect(change(state.ctx.userId, "viewer")).rejects.toThrow(/owner's role/);
  await expect(change(outsider, "admin")).rejects.toThrow(/could not be found/);
  await expect(change(editor, "owner")).rejects.toThrow();
});
