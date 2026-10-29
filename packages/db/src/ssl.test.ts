import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { databaseSsl } from "./ssl.js";

const pooler = "postgresql://user:password@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

describe("database TLS", () => {
  it.each([
    pooler,
    pooler.replace(":5432", ":6543"),
    "postgresql://user:password@db.projectref.supabase.co:5432/postgres",
  ])("verifies Supabase certificates with the published CA: %s", (url) => {
    const ssl = databaseSsl(url, {});
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    if (typeof ssl !== "object" || typeof ssl.ca !== "string") throw new Error("Missing Supabase CA");
    const ca = new X509Certificate(ssl.ca);
    expect(ca.ca).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(ca.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
    // No custom hostname checker may bypass Node's default verification.
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it.each([
    "database.example.com",
    "pooler.supabase.com.example.com",
    "aws-0-region.pooler.supabase.com.example.com",
    "db.projectref.supabase.co.example.com",
    "not-supabase.com",
  ])("keeps default certificate verification for unrelated hosts: %s", (host) => {
    expect(databaseSsl(`postgresql://user:password@${host}/postgres`, {})).toBe("verify-full");
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("preserves local development for %s", (host) => {
    expect(databaseSsl(`postgresql://user:password@${host}/postgres`, {})).toBe(false);
    expect(databaseSsl(`postgresql://user:password@${host}/postgres`, { DATABASE_SSL: "verify" })).toBe("verify-full");
  });

  it("preserves explicit TLS overrides", () => {
    expect(databaseSsl(pooler, { DATABASE_SSL: "disable" })).toBe(false);
    expect(databaseSsl(pooler, { DATABASE_SSL: "require" })).toEqual({ rejectUnauthorized: false });
    expect(databaseSsl(pooler, { DATABASE_SSL: "verify-full" })).toMatchObject({ rejectUnauthorized: true });
  });
});
