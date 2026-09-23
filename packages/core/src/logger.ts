/**
 * Structured JSON logger with mandatory redaction.
 *
 * Spec §15: "Redact secrets and sensitive data from logs." Redaction runs on
 * every log call rather than at call sites, so forgetting it is not possible.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced wholesale, matched case-insensitively. */
const SENSITIVE_KEY = /(password|secret|token|api[-_]?key|authorization|cookie|credential|refresh|access[-_]?token|client[-_]?secret|encryption)/i;

/** Value shapes that look like credentials even under an innocuous key. */
const SENSITIVE_VALUE: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

const REDACTED = "[redacted]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    let out = value;
    for (const re of SENSITIVE_VALUE) out = out.replace(re, REDACTED);
    return out;
  }
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface LogContext {
  /** Correlation ID threaded through HTTP request → job → AI call (spec §12.1). */
  correlationId?: string;
  workspaceId?: string;
  userId?: string;
  jobId?: string;
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(bound: LogContext): Logger;
}

export function createLogger(level: LogLevel = "info", bound: LogContext = {}, sink = console): Logger {
  const emit = (lvl: LogLevel, msg: string, ctx?: LogContext) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redact({ ...bound, ...ctx }) as Record<string, unknown>),
    });
    if (lvl === "error") sink.error(line);
    else if (lvl === "warn") sink.warn(line);
    else sink.log(line);
  };

  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
    child: (extra) => createLogger(level, { ...bound, ...extra }, sink),
  };
}
