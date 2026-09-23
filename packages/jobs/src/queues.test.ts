import { describe, it, expect } from "vitest";
import { toJobId } from "./queues.js";

/**
 * BullMQ rejects a custom job id containing ":" — it namespaces keys as
 * `bull:<queue>:<id>`. Our idempotency keys are colon-separated, so the
 * translation has to be both valid and collision-free.
 */
describe("toJobId", () => {
  it("removes colons, which BullMQ rejects", () => {
    expect(toJobId("crawl:abc-123")).not.toContain(":");
    expect(toJobId("qa:abc:v2")).not.toContain(":");
  });

  it("is injective — distinct keys never collide", () => {
    const keys = [
      "crawl:a", "crawl_a", "crawl:a:b", "crawl_a_b", "crawl__a",
      "qa:x:v1", "qa:x:v2", "research:biz:global:2026-01-01",
      "publish:wordpress:art:3", "publish:wordpress:art:30",
    ];
    const ids = keys.map(toJobId);
    expect(new Set(ids).size).toBe(keys.length);
  });

  it("is stable, so the same work dedupes", () => {
    expect(toJobId("crawl:src-1")).toBe(toJobId("crawl:src-1"));
  });

  it("leaves ordinary characters alone", () => {
    expect(toJobId("crawl-src-1")).toBe("crawl-src-1");
  });
});
