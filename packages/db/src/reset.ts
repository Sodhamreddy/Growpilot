import { config as loadEnv } from "dotenv";
import { fileURLToPath as envFileURLToPath } from "node:url";
import { dirname as envDirname, join as envJoin } from "node:path";

loadEnv({
  path: envJoin(envDirname(envFileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
  override: false,
});

import { createInterface } from "node:readline/promises";
import postgres from "postgres";

/**
 * Clear all workspace data so the app can be exercised as a real user.
 *
 * Deletes every user, workspace and everything cascading from them. Refuses to
 * run against production, and asks for confirmation unless --yes is passed,
 * because this is irreversible.
 *
 *   pnpm db:reset          # prompts first
 *   pnpm db:reset --yes    # for scripts
 *   pnpm db:reset --demo   # clears, then leaves the seeded demo in place
 */

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to reset a production database.");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const [counts] = await sql`
      select
        (select count(*) from users)::int      as users,
        (select count(*) from workspaces)::int as workspaces,
        (select count(*) from articles)::int   as articles
    `;

    console.log(
      `About to delete ${counts!["users"]} user(s), ${counts!["workspaces"]} workspace(s) ` +
        `and ${counts!["articles"]} article(s).`,
    );

    if (!process.argv.includes("--yes")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Type "delete" to confirm: ');
      rl.close();
      if (answer.trim().toLowerCase() !== "delete") {
        console.log("Cancelled. Nothing was deleted.");
        return;
      }
    }

    // Everything hangs off users and workspaces by foreign key with ON DELETE
    // CASCADE, so removing those two clears the rest. Sessions go first so no
    // request can act on half-deleted state mid-transaction.
    await sql.begin(async (tx) => {
      await tx`delete from sessions`;
      await tx`delete from workspaces`;
      await tx`delete from users`;
    });

    console.log("Cleared.\n");
    console.log("Next: sign up at /signin and you will be taken through onboarding.");
    console.log("Remember to run `pnpm dev:worker` — it executes the crawl.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
