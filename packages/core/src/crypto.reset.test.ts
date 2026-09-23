import { describe, it, expect } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { newToken } from "./ids.js";

/**
 * Properties the reset and OAuth flows depend on.
 *
 * These test the primitives rather than the routes, because the routes need a
 * database and a live Google. What must hold regardless: tokens are long enough
 * not to be guessed, hashing is one-way and deterministic, and the comparison
 * used for `state` and `nonce` does not leak position through timing.
 */

const hashToken = (t: string) => createHash("sha256").update(t).digest("base64url");

function constantTimeEqual(a: string, b: string): boolean {
  // Hashing first means the comparison is always over equal-length buffers,
  // so a length difference cannot throw or short-circuit.
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

describe("reset and OAuth tokens", () => {
  it("are long enough that guessing is not a threat", () => {
    // 32 bytes → 256 bits of entropy.
    const token = newToken(32);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("are unique across many draws", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newToken(32)));
    expect(seen.size).toBe(500);
  });

  it("are URL-safe, so they survive being put in a link", () => {
    for (let i = 0; i < 50; i++) {
      const token = newToken(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });
});

describe("token hashing", () => {
  it("is deterministic, so a stored hash matches on lookup", () => {
    const token = newToken(32);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("does not reveal the token", () => {
    const token = newToken(32);
    expect(hashToken(token)).not.toContain(token);
  });

  it("gives different hashes for different tokens", () => {
    expect(hashToken(newToken(32))).not.toBe(hashToken(newToken(32)));
  });
});

describe("constant-time comparison", () => {
  it("accepts an exact match", () => {
    const value = newToken(24);
    expect(constantTimeEqual(value, value)).toBe(true);
  });

  it("rejects a near match", () => {
    const value = newToken(24);
    expect(constantTimeEqual(value, value.slice(0, -1) + "X")).toBe(false);
  });

  it("handles different lengths without throwing", () => {
    // The naive timingSafeEqual on raw strings throws on a length mismatch,
    // which itself leaks whether the length was right. Hashing first avoids it.
    expect(() => constantTimeEqual("short", newToken(32))).not.toThrow();
    expect(constantTimeEqual("short", newToken(32))).toBe(false);
  });

  it("rejects an empty candidate", () => {
    expect(constantTimeEqual("", newToken(24))).toBe(false);
  });
});
