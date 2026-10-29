import { createDatabase } from "./client.js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath as envFileURLToPath } from "node:url";
import { dirname as envDirname, join as envJoin } from "node:path";

// Load the monorepo-root .env before anything reads process.env.
loadEnv({
  path: envJoin(envDirname(envFileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
  override: false,
});

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashPassword, slugify } from "@ob/core";
import * as s from "./schema.js";

/**
 * Development seed.
 *
 * Creates one workspace with a confirmed business, a small set of verified
 * facts, and an active brand voice — enough to exercise generation and the
 * quality gates end to end. Refuses to run against a production database.
 */

const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "demo-password-please-change";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed a production database.");
    process.exit(1);
  }

  const { sql, db } = createDatabase(url, { max: 1 });

  try {
    const [existing] = await db
      .select({ id: s.users.id })
      .from(s.users)
      .where(eq(s.users.emailNormalized, DEMO_EMAIL))
      .limit(1);

    if (existing) {
      console.log(`Demo user already exists (${DEMO_EMAIL}). Nothing to do.`);
      return;
    }

    const [user] = await db
      .insert(s.users)
      .values({
        email: DEMO_EMAIL,
        emailNormalized: DEMO_EMAIL,
        name: "Demo User",
        authProvider: "email",
        passwordHash: hashPassword(DEMO_PASSWORD),
        status: "active",
      })
      .returning();

    const [workspace] = await db
      .insert(s.workspaces)
      .values({
        ownerId: user!.id,
        name: "Demo workspace",
        slug: `${slugify("Demo workspace")}-${randomBytes(3).toString("hex")}`,
        onboardingCompletedAt: new Date(),
        settings: {
          requireApprovalBeforePublish: true,
          requireHumanReviewForSensitive: true,
          minSeoScoreToPublish: 70,
          minVoiceScoreToPublish: 70,
        },
      })
      .returning();

    await db.insert(s.workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: user!.id,
      role: "owner",
    });

    const [business] = await db
      .insert(s.businesses)
      .values({
        workspaceId: workspace!.id,
        name: "Northside Dental",
        industry: "Dental clinic",
        audience: "Families and working adults in the city",
        description: "A family dental practice offering general and cosmetic dentistry.",
        usp: "Same-week appointments with no referral needed",
        primaryCta: "Book a consultation",
        websiteUrl: "https://example.com",
        confirmedAt: new Date(),
        confirmedBy: user!.id,
      })
      .returning();

    // Verified facts: generation may state these directly (spec §15.1).
    await db.insert(s.businessFacts).values(
      [
        { key: "service", value: "Dental implants", confidence: 0.95 },
        { key: "service", value: "Teeth whitening", confidence: 0.92 },
        { key: "service", value: "Routine check-ups and hygiene", confidence: 0.94 },
        { key: "usp", value: "Same-week appointments with no referral needed", confidence: 0.88 },
        { key: "cta", value: "Book a consultation", confidence: 0.9 },
      ].map((f) => ({
        ...f,
        workspaceId: workspace!.id,
        businessId: business!.id,
        sourceUrl: "https://example.com/services",
        sourceQuote: `We offer ${f.value.toLowerCase()}.`,
        verified: true,
      })),
    );

    await db.insert(s.businessLocations).values({
      workspaceId: workspace!.id,
      businessId: business!.id,
      label: "Main clinic",
      streetAddress: "12 Example Street",
      locality: "Hyderabad",
      region: "Telangana",
      country: "IN",
      phone: "+91 40 0000 0000",
      sourceUrl: "https://example.com/contact",
      confidence: 0.9,
    });

    await db.insert(s.brandVoices).values({
      workspaceId: workspace!.id,
      businessId: business!.id,
      version: 1,
      profile: {
        tone: ["professional", "reassuring"],
        toneIntensity: 0.6,
        formality: "balanced",
        sentenceStyle: "explanatory",
        pointOfView: "second-person",
        emotionalStyle: "warm",
        ctaStyle: "consultation",
        spelling: "en-IN",
        formattingHabits: {
          useHeadings: true,
          useBullets: true,
          avgSentenceWords: 17,
          useExamples: true,
        },
      },
      bannedTerms: ["guaranteed", "painless", "#1", "cure", "instant results", "risk-free"],
      preferredTerms: [
        { use: "consultation", insteadOf: "sales call" },
        { use: "treatment", insteadOf: "procedure" },
      ],
      samples: [
        {
          sourceUrl: "https://example.com/about",
          text:
            "We know a dental visit is not most people's idea of a good afternoon. That is why we " +
            "explain every step before we start, and why we never recommend treatment you do not need. " +
            "If you have a question, ask us. We would rather answer it twice than have you worry.",
        },
      ],
      isActive: true,
      approvedAt: new Date(),
      approvedBy: user!.id,
    });

    console.log("Seed complete.\n");
    console.log(`  Email:     ${DEMO_EMAIL}`);
    console.log(`  Password:  ${DEMO_PASSWORD}`);
    console.log(`  Workspace: ${workspace!.name}`);
    console.log(`  Business:  ${business!.name} (profile confirmed, voice active)\n`);
    console.log("Change this password before exposing the app to anyone.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
