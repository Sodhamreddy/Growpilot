import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { unchangedSocialTopic, requireSocialWrite } from "./social-write";

describe("concurrent social writes", () => {
  it("scopes writes to the workspace, topic and full database revision", () => {
    const query = new PgDialect().sqlToQuery(unchangedSocialTopic("workspace", { id: "post", revision: "1793000000.123456" })!);
    expect(query.params).toEqual(["workspace", "post", "1793000000.123456"]);
    expect(query.sql).toContain("extract(epoch");
  });
  it("rejects a stale result instead of overwriting a newer schedule or image", () => {
    expect(() => requireSocialWrite([])).toThrow("changed while you were working");
    expect(() => requireSocialWrite([{ id: "post" }])).not.toThrow();
  });
});
