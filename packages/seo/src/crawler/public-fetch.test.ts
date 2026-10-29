import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { publicFetch } from "./public-fetch.js";

beforeEach(() => vi.resetAllMocks());
describe("public connection pinning", () => {
  it("uses the checked address for the socket without a second DNS lookup", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation((_url, opts, callback) => {
      opts.lookup("example.com", {}, (error: unknown, address: string) => {
        expect(error).toBeNull(); expect(address).toBe("8.8.8.8");
      });
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => callback(Object.assign(Readable.from([Buffer.from("hello")]), { statusCode: 200, headers: {} }));
      return req;
    });
    expect(await (await publicFetch("https://example.com")).text()).toBe("hello");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("refuses a DNS result containing even one private address before opening a socket", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(publicFetch("https://example.com")).rejects.toMatchObject({ code: "crawl_blocked" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("honors cancellation while DNS is unresolved", async () => {
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = publicFetch("https://example.com", { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
