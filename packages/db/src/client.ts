import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(url: string, opts: { max?: number; onnotice?: () => void } = {}) {
  /*
   * Pool size.
   *
   * Against a pooled Postgres endpoint (Supabase's pgBouncer on port 6543, or
   * any transaction pooler) the server is already pooling, so a large client
   * pool buys nothing and can exhaust the pooler's own limit. Against a direct
   * connection this is the real concurrency.
   */
  const max = opts.max ?? Number(process.env.DATABASE_POOL_MAX ?? 10);

  /*
   * Generous, because the database is now a network hop away rather than a
   * local process. A cold Supabase instance can take a few seconds to accept
   * its first connection, and failing a page load over that is worse than
   * waiting for it.
   */
  const connectTimeout = Number(process.env.DATABASE_CONNECT_TIMEOUT ?? 30);

  /*
   * How long a pooled connection may sit idle before it is dropped.
   *
   * Managed Postgres caps total connections per project, and an idle connection
   * still counts against that cap. Releasing them keeps a worker that is mostly
   * waiting on a model from holding slots the web app needs.
   */
  const idleTimeout = Number(process.env.DATABASE_IDLE_TIMEOUT ?? 20);

  /*
   * TLS.
   *
   * Managed Postgres (Supabase, Neon, RDS) requires it, and the credential is
   * on the wire either way — so it is on by default and only a plain localhost
   * URL opts out. `require` rather than full chain verification because these
   * providers front the database with certificates the default Node trust store
   * does not always carry; the connection is still encrypted.
   *
   * Set DATABASE_SSL=disable for a local server, or =verify to demand a chain
   * that validates.
   */
  const sslMode = process.env.DATABASE_SSL
    ?? (/localhost|127\.0\.0\.1/.test(url) ? "disable" : "require");

  const ssl =
    sslMode === "disable" ? false
    : sslMode === "verify" ? "verify-full" as const
    : { rejectUnauthorized: false };

  const sql = postgres(url, {
    max,
    idle_timeout: idleTimeout,
    connect_timeout: connectTimeout,
    ssl,
    // Postgres NOTICE output is noise in application logs.
    onnotice: opts.onnotice ?? (() => {}),
    /*
     * No prepared statements.
     *
     * Required behind a transaction pooler — Supabase's port 6543, pgBouncer,
     * Neon's pooled endpoint. Those hand a different backend to each
     * transaction, so a statement prepared on one is missing on the next and
     * queries fail intermittently under load, which is the worst way to find
     * out about it.
     */
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

// Next development reloads route bundles independently. Keep one pool per process,
// otherwise abandoned bundles retain connections and starve the single-client dev DB.
const globalDb = globalThis as typeof globalThis & {
  __ourBrandDatabase?: { db: Database; close: () => Promise<void> };
};

export function getDb(url: string): Database {
  globalDb.__ourBrandDatabase ??= (() => {
    const { db, close } = createDatabase(url);
    return { db, close };
  })();
  return globalDb.__ourBrandDatabase.db;
}

export async function closeDb(): Promise<void> {
  await globalDb.__ourBrandDatabase?.close();
  delete globalDb.__ourBrandDatabase;
}
