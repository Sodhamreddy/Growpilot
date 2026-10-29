import { describe, expect, it } from "vitest";
import { readRequestJson } from "./request-json";

const request = (value: unknown) => new Request("https://example.test", { method: "POST", body: JSON.stringify(value) });
describe("bounded JSON requests", () => {
  it("allows article content and batches of review records", async () => {
    const body = { article: "a".repeat(100_000), reviews: Array.from({ length: 500 }, () => ({ text: "Review", rating: 5 })) };
    expect(await readRequestJson(request(body))).toEqual(body);
  });
  it("rejects oversized bodies without relying on a content-length header", async () => {
    await expect(readRequestJson(request("a".repeat(1_048_576)))).rejects.toThrow(/too large/);
  });
  it("rejects many invalid array elements before schema validation", async () => {
    await expect(readRequestJson(request(Array(10_000).fill(null)))).rejects.toThrow(/too large/);
  });
  it("allows the existing logo size only when the upload route opts in", async () => {
    const body = { logoDataUrl: "data:image/png;base64," + "a".repeat(7_100_000) };
    await expect(readRequestJson(request(body))).rejects.toThrow(/too large/);
    expect(await readRequestJson(request(body), 8 * 1024 * 1024)).toEqual(body);
    await expect(readRequestJson(request(Array(10_000).fill(null)), 8 * 1024 * 1024)).rejects.toThrow(/too large/);
  });
  it("rejects deeply nested objects", async () => {
    let body: unknown = null;
    for (let i = 0; i < 40; i++) body = { child: body };
    await expect(readRequestJson(request(body))).rejects.toThrow(/complex/);
  });
});
