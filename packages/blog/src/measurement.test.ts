import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchMeasurement } from "./measurement.js";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credential = { clientEmail: "test@example.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), property: "sc-domain:example.com" };
afterEach(() => vi.unstubAllGlobals());
describe("Google measurement", () => {
  it("loads daily Search Console totals without inventing missing metrics", async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [{ keys: ["2026-10-01"], clicks: 0, impressions: 100 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [{ keys: ["2026-10-01", "test query"], clicks: 0, impressions: 30 }] })));
    vi.stubGlobal("fetch", mock);
    const rows = await fetchMeasurement("google_search_console", credential);
    expect(rows.map(r => [r.metric, r.value])).toEqual([["search_clicks", 0], ["search_impressions", 100], ["search_query_clicks", 0], ["search_query_impressions", 30]]);
    expect(mock.mock.calls[1]![0]).toContain("sc-domain%3Aexample.com");
  });
  it("normalizes GA4 dates and numeric strings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [{ dimensionValues: [{ value: "20261001" }], metricValues: [{ value: "25" }, { value: "30" }, { value: "2" }] }] }))));
    const rows = await fetchMeasurement("google_analytics", { ...credential, property: "1234" });
    expect(rows[0]!.date.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(rows.map(r => r.value)).toEqual([25, 30, 2]);
  });
});
