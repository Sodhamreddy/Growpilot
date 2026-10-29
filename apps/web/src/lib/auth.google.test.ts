import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const state = vi.hoisted(() => ({ database: null as unknown }));
vi.mock("@ob/db", async original => ({ ...await original<typeof import("@ob/db")>(), getDb: () => state.database }));
vi.mock("@ob/core", async original => ({ ...await original<typeof import("@ob/core")>(), config: () => ({ DATABASE_URL: "unused" }) }));
import { GoogleAccountLinkRequired, signInWithGoogle } from "./auth";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, email_normalized text, status text, auth_provider text, password_hash text, last_seen_at timestamptz);
    CREATE TABLE workspace_members (user_id uuid, workspace_id uuid);
    INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111','victim@example.com','active','email','attacker-password',NULL);
    INSERT INTO users VALUES ('22222222-2222-4222-8222-222222222222','google@example.com','active','google',NULL,NULL);
    INSERT INTO workspace_members VALUES ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');
  `);
  state.database = drizzle(pg);
}, 30000);
afterAll(async () => pg?.close());

it("does not sign a verified Google identity into an unverified email signup", async () => {
  await expect(signInWithGoogle({ email: " VICTIM@example.com ", emailVerified: true })).rejects.toBeInstanceOf(GoogleAccountLinkRequired);
  const { rows } = await pg.query<{ last_seen_at: unknown }>("SELECT last_seen_at FROM users WHERE email_normalized='victim@example.com'");
  expect(rows[0]!.last_seen_at).toBeNull();
});

it("continues to sign in existing Google accounts", async () => {
  await expect(signInWithGoogle({ email: "google@example.com", emailVerified: true })).resolves.toEqual({
    userId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333", created: false,
  });
});

it("rejects an unverified Google email before accessing the database", async () => {
  await expect(signInWithGoogle({ email: "google@example.com", emailVerified: false })).rejects.toThrow(/verified email/);
});
