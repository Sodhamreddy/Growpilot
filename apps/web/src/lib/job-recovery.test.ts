import { describe, expect, it } from "vitest";
import { mayRetryJob } from "./job-recovery";
describe("task recovery authorization", () => {
  it("permits only this workspace's repeatable analytics tasks", () => {
    expect(mayRetryJob("a", { name: "analytics.ingest", data: { workspaceId: "a" } })).toBe(true);
    expect(mayRetryJob("a", { name: "analytics.ingest", data: { workspaceId: "b" } })).toBe(false);
  });
  it("never blindly repeats publishing or paid generation", () => {
    for (const name of ["publish.article", "publish.social-post", "ai.generate-article", "maintenance.scheduled-run"]) {
      expect(mayRetryJob("a", { name, data: { workspaceId: "a" } })).toBe(false);
    }
  });
});
