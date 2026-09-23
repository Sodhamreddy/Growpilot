import { describe, it, expect, vi } from "vitest";
import { interpret, type CompanionContext } from "./interpret.js";
import { INTENTS } from "./intents.js";

/**
 * What the companion is allowed to come back with.
 *
 * This is the whole safety boundary, so it is worth stating what it defends
 * against. The model picks an action and fills in arguments; nothing checks
 * those arguments except this layer. An invented category name, a route that
 * does not exist, an action that was never defined: all of them read as
 * perfectly good JSON, and all of them would reach a real handler that spends
 * money or edits published content.
 *
 * The rule throughout is that an unrecognised anything degrades to "none"
 * rather than to a near miss. Doing approximately what somebody asked is worse
 * than admitting you did not follow.
 */

const ctx = { workspaceId: "w", userId: "u", role: "owner", correlationId: "c" } as never;

const context: CompanionContext = {
  currentPath: "/social",
  available: {
    categories: [
      { id: "c1", name: "Recipes", filled: 0, target: 7 },
      { id: "c2", name: "Seasonal Safety", filled: 3, target: 12 },
    ],
    articleSections: [
      { id: "0", heading: "" },
      { id: "1", heading: "What to expect" },
    ],
  },
};

const reply = (over: Record<string, unknown>) =>
  ({
    generate: vi.fn().mockResolvedValue({
      parsed: {
        intent: "none", reply: "ok",
        route: "", category: "", section: "", title: "", month: "", value: "",
        ...over,
      },
    }),
  }) as never;

const run = (over: Record<string, unknown>, c: CompanionContext = context) =>
  interpret(reply(over), ctx, { message: "do the thing", context: c });

describe("actions that happen immediately", () => {
  it("navigates to a known page", async () => {
    const r = await run({ intent: "navigate", route: "blog", reply: "Opening blog." });
    expect(r.intent).toBe("navigate");
    expect(r.args["route"]).toBe("blog");
    expect(r.needsConfirmation).toBe(false);
  });

  it("refuses a page that does not exist", async () => {
    // A 404 from the companion reads as a broken feature. A refusal reads as
    // a feature that is not there, which is the truth.
    const r = await run({ intent: "navigate", route: "analytics", reply: "Opening." });
    expect(r.intent).toBe("none");
  });

  it("answers a question without asking permission", async () => {
    const r = await run({ intent: "explain", reply: "Topics come from your services." });
    expect(r.intent).toBe("explain");
    expect(r.needsConfirmation).toBe(false);
    expect(r.action).toBeNull();
  });
});

describe("actions that must be approved", () => {
  it("asks before spending a model call", async () => {
    const r = await run({ intent: "generate_topics", category: "Recipes", reply: "Sure." });
    expect(r.intent).toBe("generate_topics");
    expect(r.needsConfirmation).toBe(true);
    expect(r.action).toContain("budget");
  });

  it("asks before laying out a month", async () => {
    const r = await run({ intent: "plan_month", month: "2026-10", reply: "Will do." });
    expect(r.needsConfirmation).toBe(true);
    expect(r.action).toContain("schedules real posts");
  });

  it("every money-spending action carries a description", async () => {
    // A confirmation with nothing to read is a confirmation nobody reads.
    for (const spec of Object.values(INTENTS)) {
      if (!spec.confirm) continue;
      expect(spec.describe({}).length, spec.name).toBeGreaterThan(20);
    }
  });
});

describe("arguments are checked against what exists", () => {
  it("resolves a category to its id", async () => {
    const r = await run({ intent: "generate_topics", category: "Recipes", reply: "ok" });
    expect(r.args["categoryId"]).toBe("c1");
  });

  it("matches a category loosely but not blindly", async () => {
    const r = await run({ intent: "generate_topics", category: "seasonal", reply: "ok" });
    expect(r.args["categoryId"]).toBe("c2");
  });

  it("refuses a category this workspace does not have", async () => {
    /*
     * The failure this catches: a model naming a plausible category that was
     * never created. Passed through, it would reach the generate endpoint as
     * a real request and fail somewhere less legible.
     */
    const r = await run({ intent: "generate_topics", category: "Dementia Care", reply: "ok" });
    expect(r.intent).toBe("none");
  });

  it("does not match a category on a two-letter fragment", async () => {
    // "re" should not select Recipes: a substring that short matches by luck.
    const r = await run({ intent: "generate_topics", category: "re", reply: "ok" });
    expect(r.intent).toBe("none");
  });

  it("resolves a section of the open article", async () => {
    const r = await run({ intent: "revise_section", section: "What to expect", reply: "ok" });
    expect(r.args["sectionId"]).toBe("1");
  });

  it("refuses a section when no article is open", async () => {
    const r = await run(
      { intent: "revise_section", section: "Costs", reply: "ok" },
      { currentPath: "/social" },
    );
    expect(r.intent).toBe("none");
  });

  it("refuses a malformed month", async () => {
    for (const bad of ["October", "2026-13", "next month", "10-2026"]) {
      const r = await run({ intent: "plan_month", month: bad, reply: "ok" });
      expect(r.intent, bad).toBe("none");
    }
  });

  it("accepts a well-formed month", async () => {
    const r = await run({ intent: "plan_month", month: "2026-11", reply: "ok" });
    expect(r.intent).toBe("plan_month");
  });
});

describe("what the model cannot smuggle through", () => {
  it("refuses an action that does not exist", async () => {
    const r = await run({ intent: "delete_everything", reply: "Done." });
    expect(r.intent).toBe("none");
    expect(r.needsConfirmation).toBe(false);
  });

  it("keeps the model's words when refusing the action", async () => {
    // The action is dropped, the sentence is not: "I cannot do that here" is
    // still useful to read.
    const r = await run({ intent: "not_a_thing", reply: "I cannot do that here." });
    expect(r.reply).toBe("I cannot do that here.");
  });

  it("supplies a reply when the model returns none", async () => {
    const r = await run({ intent: "none", reply: "" });
    expect(r.reply.length).toBeGreaterThan(10);
  });

  it("strips dashes from what the companion says", async () => {
    const r = await run({ intent: "explain", reply: "Topics come from services — not keywords." });
    expect(r.reply).not.toMatch(/[—–]/);
  });

  it("survives a malformed response rather than throwing", async () => {
    for (const bad of [undefined, null, "not an object", 7]) {
      const g = { generate: vi.fn().mockResolvedValue({ parsed: bad }) } as never;
      const r = await interpret(g, ctx, { message: "hi", context });
      expect(r.intent).toBe("none");
    }
  });
});

describe("the prompt carries its constraints", () => {
  it("lists only real pages and real categories", async () => {
    const g = reply({ intent: "none", reply: "ok" });
    await interpret(g, ctx, { message: "where is analytics", context });
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("Blog Automation");
    expect(system).toContain("Recipes (0/7)");
    expect(system).not.toContain("Analytics");
  });

  it("tells the model to prefer answering over guessing", async () => {
    const g = reply({ intent: "none", reply: "ok" });
    await interpret(g, ctx, { message: "hi", context });
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("Prefer \"explain\" over guessing");
    expect(system).toContain("Never claim to have done something");
  });

  it("passes recent turns so a follow-up resolves", async () => {
    const g = reply({ intent: "none", reply: "ok" });
    await interpret(g, ctx, {
      message: "do that one instead",
      context,
      history: [{ role: "user", content: "generate recipes" }],
    });
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("generate recipes");
  });
});
