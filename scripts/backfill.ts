import { config as loadEnv } from "dotenv";
import { fileURLToPath as envFileURLToPath } from "node:url";
import { dirname as envDirname, join as envJoin } from "node:path";

// Load the monorepo-root .env before anything reads process.env.
loadEnv({
  path: envJoin(envDirname(envFileURLToPath(import.meta.url)), "..", ".env"),
  override: false,
});

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and } from "drizzle-orm";
import { fillMissingInstructions } from "@ob/pipeline";
import { categoriesFor } from "@ob/social";
import * as s from "@ob/db";

/**
 * Fill in what clients created before these features existed never got:
 * writing instructions, and social content categories.
 *
 * Both are written on the paths a *new* client takes — instructions when the
 * client is added and again after each crawl, categories the first time the
 * social pillar is opened. Neither path reaches a client that already existed
 * and whose crawl already finished, which left real clients staring at six
 * empty boxes and an empty category list with no way to fill either short of
 * doing it by hand.
 *
 * Safe to run repeatedly. It only ever adds what is missing, so anything a
 * customer has written or arranged survives — the same rule the live paths
 * follow, calling the same functions, so the two cannot drift apart.
 *
 *   pnpm --filter=@ob/db backfill                # write
 *   pnpm --filter=@ob/db backfill --dry          # show, change nothing
 */

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  const dry = process.argv.includes("--dry");
  const sql = postgres(url, { prepare: false });
  const db = drizzle(sql, { schema: s });

  try {
    const rows = await db.select().from(s.businesses).orderBy(s.businesses.name);
    if (rows.length === 0) {
      console.log("No businesses found.");
      return;
    }

    console.log(`${rows.length} client${rows.length === 1 ? "" : "s"}${dry ? " (dry run)" : ""}`);
    console.log("\nInstructions\n");

    for (const business of rows) {
      /*
       * Services and locations come from the facts the crawl already stored,
       * not from a fresh crawl. A client being backfilled has been crawled;
       * re-fetching their site to rebuild a list that is sitting in the
       * database would be slow and would change nothing.
       */
      const facts = await db
        .select({ value: s.businessFacts.value })
        .from(s.businessFacts)
        .where(and(
          eq(s.businessFacts.businessId, business.id),
          eq(s.businessFacts.key, "service"),
        ));

      const locations = await db
        .select({ locality: s.businessLocations.locality })
        .from(s.businessLocations)
        .where(eq(s.businessLocations.businessId, business.id));

      const filled = fillMissingInstructions(business.prompts, {
        name: business.name,
        industry: business.industry,
        audience: business.audience,
        description: business.description,
        usp: business.usp,
        primaryCta: business.primaryCta,
        // Facts store a service as "Name — description"; only the name steers.
        services: facts.map((f) => f.value.split(/\s+[—-]\s+/)[0]!.trim()),
        locations: [...new Set(
          locations.map((l) => l.locality).filter((v): v is string => Boolean(v)),
        )],
      });

      const boxes = [
        ["blog.topics", business.prompts?.blog?.topics, filled.blog?.topics],
        ["blog.article", business.prompts?.blog?.article, filled.blog?.article],
        ["social.topics", business.prompts?.social?.topics, filled.social?.topics],
        ["social.post", business.prompts?.social?.post, filled.social?.post],
        ["social.image", business.prompts?.social?.image, filled.social?.image],
      ] as const;

      const written = boxes.filter(([, before, after]) => !before?.trim() && after?.trim());
      const kept = boxes.filter(([, before]) => before?.trim());

      if (written.length === 0) {
        console.log(`${business.name}: nothing to fill (${kept.length} already written)`);
        continue;
      }

      console.log(
        `${business.name}: filling ${written.map(([n]) => n).join(", ")}` +
          (kept.length ? ` · keeping ${kept.length} existing` : ""),
      );

      if (!dry) {
        await db
          .update(s.businesses)
          .set({ prompts: filled, updatedAt: new Date() })
          .where(eq(s.businesses.id, business.id));
      }
    }

    // ── Social categories ───────────────────────────────────────────────────

    console.log("\nCategories\n");

    for (const business of rows) {
      /*
       * The same gate the live route applies.
       *
       * Categories are built from the industry and the networks on record,
       * both of which come from an unverified crawl until somebody confirms
       * the profile. Seeding from unconfirmed facts here would route around
       * a check that exists precisely to stop that.
       */
      if (!business.confirmedAt) {
        console.log(`${business.name}: skipped, profile not confirmed`);
        continue;
      }

      const existing = await db
        .select({ name: s.socialCategories.name, position: s.socialCategories.position })
        .from(s.socialCategories)
        .where(eq(s.socialCategories.businessId, business.id));

      const seeds = categoriesFor(business.industry, business.socialProfiles);
      const have = new Set(existing.map((c) => c.name));
      const missing = seeds.filter((c) => !have.has(c.name));

      if (missing.length === 0) {
        console.log(`${business.name}: nothing to add (${existing.length} categories)`);
        continue;
      }

      console.log(
        `${business.name}: adding ${missing.length} · ${missing.map((c) => c.name).join(", ")}` +
          (existing.length ? ` · keeping ${existing.length} existing` : ""),
      );

      if (!dry) {
        // After the existing ones, so nothing a person arranged shifts.
        const next = existing.reduce((n, c) => Math.max(n, (c.position ?? 0) + 1), 0);
        await db
          .insert(s.socialCategories)
          .values(missing.map((category, offset) => ({
            workspaceId: business.workspaceId,
            businessId: business.id,
            name: category.name,
            description: category.description,
            position: next + offset,
            targetCount: category.targetCount,
          })))
          .onConflictDoNothing();
      }
    }

    console.log(dry ? "\nDry run: nothing was written." : "\nDone.");
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
