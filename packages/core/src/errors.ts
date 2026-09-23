/**
 * Typed application errors.
 *
 * Every error carries a machine `code`, an HTTP `status`, and a `safeMessage`
 * that is cleared for display to end users. Internal detail stays in `cause`
 * and is only ever written to logs — spec §14.1 ("error: safe failure message")
 * and §10.3 ("human-readable errors with retry/fix actions").
 */

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "tenant_violation"
  | "provider_error"
  | "provider_timeout"
  | "budget_exceeded"
  | "quality_gate_failed"
  | "crawl_blocked"
  | "dependency_unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  rate_limited: 429,
  tenant_violation: 403,
  provider_error: 502,
  provider_timeout: 504,
  budget_exceeded: 402,
  quality_gate_failed: 422,
  crawl_blocked: 422,
  dependency_unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to render in a UI. Never contains secrets or internal detail. */
  readonly safeMessage: string;
  /** Structured, non-sensitive context for logs and for the UI's fix action. */
  readonly details: Record<string, unknown>;
  /** Whether a caller may sensibly retry the same operation. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    safeMessage: string,
    opts: { details?: Record<string, unknown>; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(safeMessage, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.safeMessage = safeMessage;
    this.details = opts.details ?? {};
    this.retryable =
      opts.retryable ??
      (code === "rate_limited" || code === "provider_timeout" || code === "provider_error");
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.safeMessage, details: this.details, retryable: this.retryable },
    };
  }
}

export const unauthorized = (m = "You need to sign in to continue.") => new AppError("unauthorized", m);
export const forbidden = (m = "You do not have access to this resource.") => new AppError("forbidden", m);
export const notFound = (what = "resource") => new AppError("not_found", `That ${what} could not be found.`);
export const conflict = (m: string) => new AppError("conflict", m);
export const validationFailed = (m: string, details?: Record<string, unknown>) =>
  new AppError("validation_failed", m, details ? { details } : {});

/**
 * Connection-level failures from Postgres and Redis clients.
 *
 * These are not unknown internal errors — they mean a dependency is down, which
 * is a different HTTP status, a different retry policy, and a different message.
 * Collapsing them into a generic 500 hides the one thing an operator needs.
 */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ECONNRESET", "EPIPE", "CONNECT_TIMEOUT", "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED", "CONNECTION_ENDED",
]);

function connectionFailureTarget(e: unknown): "database" | "cache" | null {
  if (!e || typeof e !== "object") return null;

  const err = e as { code?: unknown; message?: unknown; errno?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";

  const isConnectionError =
    CONNECTION_ERROR_CODES.has(code) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect\s?timeout|terminating connection|server closed the connection/i.test(
      message,
    );
  if (!isConnectionError) return null;

  // Redis errors surface through ioredis and mention it by name; anything else
  // reaching here came from the Postgres client.
  return /redis|ioredis/i.test(message) || /redis/i.test(String((e as { name?: unknown }).name ?? ""))
    ? "cache"
    : "database";
}

/** Narrow an unknown thrown value to an AppError, wrapping anything else. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;

  const target = connectionFailureTarget(e);
  if (target) {
    const label = target === "database" ? "database" : "cache";
    return new AppError(
      "dependency_unavailable",
      `We could not reach the ${label}. This is a configuration or connectivity problem, not something you did.`,
      {
        cause: e,
        retryable: true,
        details: {
          dependency: target,
          // The operator-facing hint. Safe to show: it names no credential.
          hint:
            target === "database"
              ? "Check that DATABASE_URL points at a running PostgreSQL server and that migrations have been applied."
              : "Check that REDIS_URL points at a running Redis-compatible server.",
        },
      },
    );
  }

  return new AppError("internal", "Something went wrong on our side. Please try again.", { cause: e });
}
