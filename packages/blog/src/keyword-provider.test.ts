import { afterEach, describe, it, expect, vi } from "vitest";
import { DataForSeoProvider } from "./keyword-provider.js";
afterEach(() => vi.unstubAllGlobals());
describe("keyword metrics", () => {
  it("preserves real zeroes and leaves unavailable keywords null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ keyword: "known", keyword_info: { search_volume: 0, cpc: 1.25 }, keyword_properties: { keyword_difficulty: 12 } }] }] }] }))));
    const rows = await new DataForSeoProvider("test", "test", 2840).metrics(["Known", "missing"]);
    expect(rows).toEqual([{ term: "Known", volume: 0, difficulty: 12, cpcMicros: 1250000 }, { term: "missing", volume: null, difficulty: null, cpcMicros: null }]);
  });
  it("surfaces provider task failures instead of recording missing data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 40200 }] }))));
    await expect(new DataForSeoProvider("test", "test", 2840).metrics(["term"])).rejects.toThrow(/Keyword metrics/);
  });
});
