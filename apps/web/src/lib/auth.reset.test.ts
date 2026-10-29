import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { verifyPasswordAsync } from "@ob/core";

const state = vi.hoisted(() => ({ database: null as unknown }));
vi.mock("@ob/db", async original => ({ ...await original<typeof import("@ob/db")>(), getDb: () => state.database }));
vi.mock("@ob/core", async original => ({ ...await original<typeof import("@ob/core")>(), config: () => ({ DATABASE_URL: "unused" }) }));
import { completePasswordReset } from "./auth";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, password_hash text, updated_at timestamptz);
    CREATE TABLE password_resets (id uuid PRIMARY KEY, user_id uuid, token_hash text UNIQUE, expires_at timestamptz, used_at timestamptz);
    CREATE TABLE sessions (id uuid PRIMARY KEY, user_id uuid);
    INSERT INTO users (id) VALUES ('11111111-1111-4111-8111-111111111111');
    INSERT INTO sessions (id,user_id) VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
  `);
  await pg.query("INSERT INTO password_resets (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [
    "33333333-3333-4333-8333-333333333333", "11111111-1111-4111-8111-111111111111", createHash("sha256").update("single-use-token").digest("base64url"),
  ]);
  state.database = drizzle(pg);
}, 30000);
afterAll(async () => pg?.close());

it("allows exactly one concurrent reset and invalidates every old session", async () => {
  const outcomes = await Promise.allSettled([
    completePasswordReset("single-use-token", "first-password"),
    completePasswordReset("single-use-token", "second-password"),
  ]);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
  const winner = outcomes[0]!.status === "fulfilled" ? "first-password" : "second-password";
  const { rows } = await pg.query<{ password_hash: string }>("SELECT password_hash FROM users");
  expect(await verifyPasswordAsync(winner, rows[0]!.password_hash)).toBe(true);
  expect((await pg.query("SELECT * FROM sessions")).rows).toHaveLength(0);
  await expect(completePasswordReset("single-use-token", "third-password")).rejects.toThrow(/already used/);
});
