import { config as loadEnv } from "dotenv";
import { fileURLToPath as envFileURLToPath } from "node:url";
import { dirname as envDirname, join as envJoin } from "node:path";

// Load the monorepo-root .env before anything reads process.env.
loadEnv({
  path: envJoin(envDirname(envFileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
  override: false,
});

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Migration runner.
 *
 * Order matters: hand-written `0000_*.sql` files (extensions) run first, then
 * Drizzle's generated schema migrations, then hand-written `9999_*.sql` files
 * (indexes that depend on the tables existing). Each hand-written file is
 * recorded in `_manual_migrations` so re-runs are no-ops.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

/**
 * Hand-written SQL runs either side of Drizzle's generated migrations.
 *
 * The prefixes are `pre_`/`post_` rather than numeric: Drizzle names its own
 * files `0000_*`, `0001_*`, … so a numeric prefix here collides with them and
 * the wrong files get picked up by each pass.
 */
async function runManual(sql: postgres.Sql, prefix: "pre_" | "post_") {
  await sql`
    CREATE TABLE IF NOT EXISTS _manual_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.startsWith(prefix) && f.endsWith(".sql"))
      .sort();
  } catch {
    return;
  }

  for (const file of files) {
    const [existing] = await sql`SELECT name FROM _manual_migrations WHERE name = ${file}`;
    if (existing) {
      console.log(`  skip   ${file} (already applied)`);
      continue;
    }
    const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await sql.unsafe(body);
    await sql`INSERT INTO _manual_migrations (name) VALUES (${file})`;
    console.log(`  apply  ${file}`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    console.log("Extensions:");
    await runManual(sql, "pre_");

    console.log("Schema:");
    const hasGenerated = (await readdir(MIGRATIONS_DIR).catch(() => [])).some(
      (f) => f.endsWith(".sql") && !f.startsWith("pre_") && !f.startsWith("post_"),
    );
    if (hasGenerated) {
      await drizzleMigrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
      console.log("  applied generated migrations");
    } else {
      console.log("  none found — run `pnpm db:generate` first");
    }

    console.log("Indexes:");
    await runManual(sql, "post_");

    console.log("\nMigration complete.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
