import { describe, it, expect } from "vitest";
import { toGeminiSchema } from "./providers/google.js";

/**
 * Translating our JSON Schema into what Gemini accepts.
 *
 * The bug this pins: the translator stripped unsupported *keywords* by name,
 * anywhere in the tree, including inside `properties` where the keys are the
 * caller's own field names. A property called `format` was deleted from
 * `properties` while staying in `required`, and Gemini rejected the whole
 * request with
 *
 *   properties[topics].items.required[3]: property is not defined
 *
 * which reads like a malformed schema rather than what it was. It cost a whole
 * category generation, and nothing in the type system could have caught it,
 * because both are just strings.
 */

const translate = (schema: Record<string, unknown>) => toGeminiSchema(schema);

const TOPIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        // `format` is a field name here, not the JSON Schema keyword.
        required: ["title", "format", "pattern", "maximum"],
        properties: {
          title: { type: "string" },
          format: { type: "string", enum: ["Carousel", "Reel"] },
          pattern: { type: "string" },
          maximum: { type: "string" },
        },
      },
    },
  },
};

describe("field names that collide with schema keywords", () => {
  it("keeps a property called `format`", () => {
    const out = translate(TOPIC_SCHEMA);
    const items = (out["properties"] as never as Record<string, never>)["topics"]["items"];
    expect(Object.keys(items["properties"])).toContain("format");
  });

  it("keeps properties called `pattern` and `maximum`", () => {
    const out = translate(TOPIC_SCHEMA);
    const items = (out["properties"] as never as Record<string, never>)["topics"]["items"];
    expect(Object.keys(items["properties"])).toContain("pattern");
    expect(Object.keys(items["properties"])).toContain("maximum");
  });

  it("leaves `required` intact when the properties survive", () => {
    const out = translate(TOPIC_SCHEMA);
    const items = (out["properties"] as never as Record<string, never>)["topics"]["items"];
    expect(items["required"]).toEqual(["title", "format", "pattern", "maximum"]);
  });

  it("keeps the enum on a property named after a keyword", () => {
    const out = translate(TOPIC_SCHEMA);
    const items = (out["properties"] as never as Record<string, never>)["topics"]["items"];
    expect(items["properties"]["format"]["enum"]).toEqual(["Carousel", "Reel"]);
  });
});

describe("keywords are still stripped where they are keywords", () => {
  it("drops `additionalProperties`", () => {
    const out = translate(TOPIC_SCHEMA);
    expect(out).not.toHaveProperty("additionalProperties");
  });

  it("drops `minItems` from an array node", () => {
    const out = translate(TOPIC_SCHEMA);
    const topics = (out["properties"] as never as Record<string, never>)["topics"];
    expect(topics).not.toHaveProperty("minItems");
  });

  it("drops a genuine `format` constraint on a string", () => {
    // Same word, different position: here it constrains the string, and
    // Gemini does not support it.
    const out = translate({
      type: "object",
      required: ["when"],
      properties: { when: { type: "string", format: "date-time" } },
    });
    const when = (out["properties"] as never as Record<string, never>)["when"];
    expect(when).not.toHaveProperty("format");
    expect(when["type"]).toBe("string");
  });
});

describe("a dangling required name", () => {
  it("is pruned rather than sent", () => {
    // Sending it is the 400 above. Dropping it costs one optional field.
    const out = translate({
      type: "object",
      required: ["kept", "neverDefined"],
      properties: { kept: { type: "string" } },
    });
    expect(out["required"]).toEqual(["kept"]);
  });

  it("is pruned at every depth", () => {
    const out = translate({
      type: "object",
      required: ["outer"],
      properties: {
        outer: {
          type: "object",
          required: ["inner", "ghost"],
          properties: { inner: { type: "string" } },
        },
      },
    });
    const outer = (out["properties"] as never as Record<string, never>)["outer"];
    expect(outer["required"]).toEqual(["inner"]);
  });
});
