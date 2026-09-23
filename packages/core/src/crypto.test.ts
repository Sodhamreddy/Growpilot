import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { seal, open, hashPassword, verifyPassword } from "./crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("credential sealing", () => {
  it("round-trips a value", () => {
    const secret = "ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxx";
    expect(open(seal(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = seal("same-value", KEY);
    const b = seal("same-value", KEY);
    expect(a).not.toBe(b);
    expect(open(a, KEY)).toBe(open(b, KEY));
  });

  it("never leaks the plaintext into the sealed form", () => {
    const sealed = seal("super-secret-token", KEY);
    expect(sealed).not.toContain("super-secret-token");
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const sealed = seal("value", KEY);
    const parts = sealed.split(".");
    // Flip a bit in the ciphertext segment.
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => open(parts.join("."), KEY)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const sealed = seal("value", KEY);
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[2]!, "base64url");
    tag[0] ^= 0xff;
    parts[2] = tag.toString("base64url");
    expect(() => open(parts.join("."), KEY)).toThrow();
  });

  it("cannot be opened with a different key", () => {
    const sealed = seal("value", KEY);
    expect(() => open(sealed, randomBytes(32).toString("base64"))).toThrow();
  });

  it("rejects a key of the wrong length with an actionable message", () => {
    expect(() => seal("value", randomBytes(16).toString("base64"))).toThrow(/openssl rand -base64 32/);
  });

  it("handles unicode and empty strings", () => {
    for (const value of ["", "日本語のトークン", "emoji 🔐 token"]) {
      expect(open(seal(value, KEY), KEY)).toBe(value);
    }
  });
});

describe("password hashing", () => {
  it("verifies a correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("salts — the same password hashes differently each time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("never stores the plaintext", () => {
    expect(hashPassword("my-plaintext-password")).not.toContain("my-plaintext-password");
  });

  it("normalises unicode so equivalent inputs verify", () => {
    // U+00E9 vs U+0065 U+0301 — visually identical, different bytes.
    const stored = hashPassword("café");
    expect(verifyPassword("café", stored)).toBe(true);
  });

  it("returns false rather than throwing on a malformed stored hash", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$bad")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
  });
});
