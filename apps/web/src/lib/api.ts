import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { AppError, toAppError, config, createLogger, type TenantContext } from "@ob/core";
import { getRedis } from "./redis";
import { readRequestJson } from "./request-json";

/**
 * API route plumbing.
 *
 * Every handler is wrapped by `route()`, which supplies: typed error → HTTP
 * mapping with safe messages (spec §14.1), structured logging with a
 * correlation ID (§12.1), and rate limiting (§15 "Rate-limit API and AI
 * endpoints").
 */

// Reads only process.env, never the validated config, so importing this module
// during a build cannot fail on missing runtime secrets.
const logger = createLogger((process.env.LOG_LEVEL as "info" | undefined) ?? "info", {
  service: "web",
});

export interface RouteOptions {
  /** Requests allowed per window, per workspace (or per IP when anonymous). */
  rateLimit?: { limit: number; windowSeconds: number };
}

/** Pull the diagnosable fields out of whatever was thrown. */
function describeCause(cause: unknown): Record<string, unknown> {
  if (cause === undefined || cause === null) return {};
  if (typeof cause !== "object") return { cause: String(cause) };

  const e = cause as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  // Postgres (node-postgres / postgres.js) error fields, then the generic ones.
  for (const key of ["message", "code", "detail", "hint", "constraint", "table",
                     "column", "routine", "severity", "name"]) {
    const value = e[key];
    if (typeof value === "string" && value !== "") picked[key] = value;
  }
  if (Object.keys(picked).length === 0) {
    picked["cause"] = Object.prototype.toString.call(cause);
  }
  if (cause instanceof Error && cause.stack) {
    // Top frames only: enough to locate the throw, short enough not to bury
    // the fields above it.
    const frames = cause.stack.split(/\r?\n/).slice(0, 4);
    picked["stack"] = frames.map((line) => line.trim()).join(" | ");
  }
  return picked;
}

export function jsonError(err: unknown): NextResponse {
  const appErr = toAppError(err);

  if (appErr.status >= 500) {
    /*
     * Describe the cause properly.
     *
     * `String(err)` on a Postgres or driver error yields "[object Object]" or a
     * bare class name, which is how a 500 ends up in the log with nothing to
     * act on — the operator sees "Unhandled route error" and has no idea what
     * broke. Postgres errors carry the useful part in `code`, `detail`,
     * `constraint` and `routine` rather than in `message`.
     */
    logger.error("Unhandled route error", { code: appErr.code, ...describeCause(appErr.cause) });
  }

  const body = appErr.toJSON();

  // In development, attach the underlying cause so a failure is diagnosable
  // from the browser instead of only from the terminal. Never in production:
  // a driver error can carry a connection string.
  if (process.env.NODE_ENV !== "production" && appErr.cause !== undefined) {
    const cause = appErr.cause as { message?: unknown; code?: unknown };
    // Driver errors often carry an empty `message` with the useful part in
    // `code`, so fall back rather than reporting an empty string.
    const detail =
      [cause?.code, cause?.message].filter((v) => typeof v === "string" && v !== "").join(": ") ||
      String(appErr.cause);
    if (detail && detail !== "{}" && detail !== "[object Object]") {
      body.error.details = { ...body.error.details, devCause: detail.slice(0, 300) };
    }
  }

  return NextResponse.json(body, {
    status: appErr.status,
    headers: appErr.retryable ? { "Retry-After": String(appErr.details?.retryInSeconds ?? 5) } : {},
  });
}

/** Wrap an authenticated handler. */
export function route<T>(
  handler: (ctx: TenantContext, req: Request) => Promise<T>,
  opts: RouteOptions = {},
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    const started = Date.now();
    try {
      const { requireTenant } = await import("./auth");
      const ctx = await requireTenant();

      if (opts.rateLimit) {
        await enforceRateLimit(`ws:${ctx.workspaceId}:${req.method}:${new URL(req.url).pathname}`, opts.rateLimit);
      }

      const result = await handler(ctx, req);
      logger.info("Request handled", {
        correlationId: ctx.correlationId,
        workspaceId: ctx.workspaceId,
        path: new URL(req.url).pathname,
        method: req.method,
        durationMs: Date.now() - started,
      });
      return NextResponse.json(result ?? { ok: true }, {
        headers: { "x-correlation-id": ctx.correlationId },
      });
    } catch (err) {
      return jsonError(err);
    }
  };
}

/** Wrap a public handler (sign-up, sign-in), rate limited by IP. */
export function publicRoute<T>(
  handler: (req: Request) => Promise<T>,
  opts: RouteOptions = {},
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    try {
      if (opts.rateLimit) {
        const hdrs = await headers();
        const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        await enforceRateLimit(`ip:${ip}:${req.method}:${new URL(req.url).pathname}`, opts.rateLimit);
      }
      return NextResponse.json((await handler(req)) ?? { ok: true });
    } catch (err) {
      return jsonError(err);
    }
  };
}

/** Parse and validate a JSON body, surfacing field errors to the UI. */
export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S, options: { maxBytes?: number } = {}): Promise<z.infer<S>> {
  const raw = await readRequestJson(req, options.maxBytes);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      fieldErrors[key] ??= issue.message;
    }
    throw new AppError("validation_failed", "Some fields need attention.", {
      details: { fields: fieldErrors },
    });
  }
  return parsed.data;
}

/**
 * Fixed-window rate limiter backed by Redis.
 *
 * Fixed windows allow a burst at a boundary; that is an accepted trade for the
 * simplicity, since these limits exist to stop runaway cost and abuse rather
 * than to shape traffic precisely.
 */
async function enforceRateLimit(
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<void> {
  // Development iterates on the same endpoint dozens of times a minute.
  // Production limits would make that unusable, and a rate limiter is an abuse
  // control, not a correctness guarantee — so it is relaxed, not disabled.
  const limit = process.env.NODE_ENV === "production" ? opts.limit : opts.limit * 40;

  const redis = getRedis();
  const window = Math.floor(Date.now() / (opts.windowSeconds * 1000));
  const redisKey = `ratelimit:${key}:${opts.windowSeconds}:${window}`;

  let count: number;
  try {
    count = Number(await withTimeout(redis.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n",
      1, redisKey, opts.windowSeconds), 750));
  } catch (error) {
    logger.warn("Rate limiter unavailable; refusing request", {
      key,
      cause: error instanceof Error ? error.message : String(error),
    });
    throw new AppError("dependency_unavailable", "Please try again shortly.", { retryable: true });
  }

  if (count > limit) {
    const retryInSeconds = Math.max(1, (await withTimeout(redis.ttl(redisKey), 750)) || opts.windowSeconds);
    throw new AppError(
      "rate_limited",
      `Too many attempts. Please try again in ${formatWait(retryInSeconds)}.`,
      {
        details: { limit, windowSeconds: opts.windowSeconds, retryInSeconds },
        retryable: true,
      },
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Turn a retry delay into something a person can act on. */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export { config, logger };
