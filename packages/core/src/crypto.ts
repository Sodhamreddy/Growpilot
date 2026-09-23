import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, scrypt, scryptSync } from "node:crypto";

/**
 * Envelope encryption for integration credentials at rest.
 *
 * Spec §11.1 "Encrypt tokens at rest" and §15 "Encrypt provider credentials".
 * AES-256-GCM with a random 96-bit IV per record. The sealed form is
 * self-describing so the key can be rotated by version prefix later.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function keyFrom(rawBase64: string): Buffer {
  const key = Buffer.from(rawBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Encrypt a UTF-8 plaintext. Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(plaintext: string, keyBase64: string): string {
  const key = keyFrom(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Decrypt a sealed value. Throws if the payload was tampered with. */
export function open(sealed: string, keyBase64: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed sealed credential.");
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = keyFrom(keyBase64);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Password hashing (spec §2.1 "Secure hash — never store plaintext").
 * scrypt with per-password salt; N=2^15 balances cost against request latency.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nS, rS, pS, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64url");
  const derived = scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
    N: Number(nS),
    r: Number(rS),
    p: Number(pS),
    maxmem: 256 * 1024 * 1024,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nS, rS, pS, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64url");
  const derived = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
    N: Number(nS),
    r: Number(rS),
    p: Number(pS),
    maxmem: 256 * 1024 * 1024,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Deterministic key for idempotent external operations (spec §11.1, §12.1). */
export function idempotencyKey(...parts: (string | number)[]): string {
  return parts.map((p) => String(p)).join(":");
}
