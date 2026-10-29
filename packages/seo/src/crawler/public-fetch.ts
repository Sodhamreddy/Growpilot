import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import { AppError, executionSignal } from "@ob/core";
import { isBlockedIp } from "./fetch.js";

/** Resolve and validate at connection time; never resolve the hostname a second time. */
export async function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new AppError("crawl_blocked", "Only public HTTP(S) addresses without URL credentials are allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const signal = executionSignal(init.signal ?? AbortSignal.timeout(30_000));
  signal.throwIfAborted();
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    lookup(host, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new AppError("crawl_blocked", "That address is not publicly reachable.");
  }
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
      signal, agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const status = res.statusCode ?? 502;
      const noBody = [204, 205, 304].includes(status) || init.method === "HEAD";
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on("error", reject);
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string") { req.destroy(); reject(new Error("publicFetch accepts string bodies only")); return; }
      req.write(init.body);
    }
    req.end();
  });
}
