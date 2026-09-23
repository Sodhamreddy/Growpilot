import { randomUUID, randomBytes } from "node:crypto";

export const newId = (): string => randomUUID();

/** URL-safe opaque token, e.g. for session cookies and invite links. */
export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const newCorrelationId = (): string => `req_${randomBytes(9).toString("base64url")}`;

/** Lowercase, hyphenated, ASCII-safe slug with a length cap. */
export function slugify(input: string, maxLength = 80): string {
  return input
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}
