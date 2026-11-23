import { describe, expect, it } from "vitest";
import { isBlogOnly, teamRoleDuty, teamRoleLabel } from "./blog-access";

describe("blog-only access", () => {
  it("limits editors on a review team to Blog Automation", () => {
    expect(isBlogOnly("editor", ["content"])).toBe(true);
    expect(isBlogOnly("editor", ["manager"])).toBe(true);
  });

  it("leaves owners, admins and editors on no team with everything", () => {
    expect(isBlogOnly("owner", ["content"])).toBe(false);
    expect(isBlogOnly("admin", ["manager"])).toBe(false);
    expect(isBlogOnly("editor", [])).toBe(false);
  });

  it("names the role", () => {
    expect(teamRoleLabel(["content"])).toBe("Content team");
    expect(teamRoleLabel(["manager"])).toBe("Manager");
    expect(teamRoleLabel(["content", "manager"])).toBe("Content team · Manager");
    expect(teamRoleLabel([])).toBeNull();
    expect(teamRoleDuty(["manager"])).toMatch(/final approval/);
  });
});
