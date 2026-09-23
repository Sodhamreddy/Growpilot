import { z } from "zod";

/**
 * Environment validation. Fails fast at boot rather than at first use, so a
 * missing secret is a startup error and never a half-configured runtime.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1, "CREDENTIAL_ENCRYPTION_KEY is required"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  AI_MOCK: z.coerce.number().int().min(0).max(1).default(0),

  CRAWL_MAX_PAGES: z.coerce.number().int().positive().max(500).default(40),
  CRAWL_MAX_DEPTH: z.coerce.number().int().positive().max(10).default(3),
  CRAWL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  CRAWL_USER_AGENT: z.string().default(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36 GrowPilotBot/0.1 (+https://kleza.io/bot)",
  ),

  /**
   * Rendering service for JavaScript-heavy sites — services/crawler.
   *
   * Optional. Unset, the crawler behaves exactly as it does without it; set and
   * running, pages that a static fetcher cannot read are retried through a real
   * browser.
   */
  CRAWLER_SERVICE_URL: z.string().url().optional(),

  /*
   * Meta (Facebook + Instagram) app credentials.
   *
   * One app covers both networks: an Instagram Business account is reached
   * through the Facebook Page it is linked to, with the same page token.
   */
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}\n\nSee .env.example.`);
  }
  return parsed.data;
}

/** Memoised accessor. Throws on first call if the environment is invalid. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test helper — resets the memoised config. */
export function resetConfig(): void {
  cached = undefined;
}
