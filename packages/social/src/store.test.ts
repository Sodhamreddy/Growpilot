import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  saveImage, readImage, deleteImage, sniffImageType, storageKind, publicImageUrl, instagramJpegUrl,
} from "./store.js";

/**
 * Post image storage.
 *
 * Isolation first: a key from one workspace must never read another's file,
 * however it is written. Then reach: only a public store can serve Instagram.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TOPIC = "33333333-3333-4333-8333-333333333333";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "img-store-"));
  process.env.IMAGE_STORE_DIR = dir;
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.unstubAllGlobals();
});

describe("local image storage", () => {
  it("saves and reads back an image under an unguessable name", async () => {
    const { key, mimeType } = await saveImage(WS, TOPIC, PNG);
    expect(mimeType).toBe("image/png");
    expect(key).toMatch(new RegExp(`^${WS}/${TOPIC}-\\d+-[0-9a-f]{24}\\.png$`));
    expect(Buffer.from((await readImage(WS, key))!.data)).toEqual(Buffer.from(PNG));
  });

  it("still reads keys from before names had a random part", async () => {
    expect(await readImage(WS, `${WS}/${TOPIC}-1.png`)).toBeNull(); // valid shape, just absent
  });

  it("never reads another workspace's image", async () => {
    const { key } = await saveImage(WS, TOPIC, PNG);
    expect(await readImage(OTHER, key)).toBeNull();
  });

  it("refuses keys that try to leave the store", async () => {
    expect(await readImage(WS, `${WS}/../${OTHER}/${TOPIC}-1.png`)).toBeNull();
    expect(await readImage(WS, "../../etc/passwd")).toBeNull();
  });

  it("deletes an image", async () => {
    const { key } = await saveImage(WS, TOPIC, PNG);
    await deleteImage(WS, key);
    expect(await readImage(WS, key)).toBeNull();
  });

  it("refuses a file that is not an image, whatever it claims to be", async () => {
    await expect(saveImage(WS, TOPIC, new TextEncoder().encode("<svg onload=alert(1)>"))).rejects.toThrow(/not a PNG/);
  });

  it("recognises JPEG and WebP by their bytes", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("image/webp");
  });

  it("has no public address, so Instagram cannot be served from it", async () => {
    expect(storageKind()).toBe("local");
    const { key } = await saveImage(WS, TOPIC, PNG);
    expect(publicImageUrl(key)).toBeNull();
    expect(await instagramJpegUrl(WS, key)).toBeNull();
  });
});

describe("Supabase image storage", () => {
  it("uploads with the service key and returns a public address", async () => {
    process.env.SUPABASE_URL = "https://proj.supabase.co/";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const calls: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization") });
      return new Response("{}", { status: 200 });
    }));

    expect(storageKind()).toBe("supabase");
    const { key } = await saveImage(WS, TOPIC, PNG);
    expect(calls.some((c) => c.url === "https://proj.supabase.co/storage/v1/bucket")).toBe(true);
    const upload = calls.find((c) => c.url.includes(`/storage/v1/object/post-images/${key}`))!;
    expect(upload.method).toBe("POST");
    expect(upload.auth).toBe("Bearer service-key");
    expect(publicImageUrl(key)).toBe(`https://proj.supabase.co/storage/v1/object/public/post-images/${key}`);
  });

  it("still reads images kept on disk from before Supabase was set up", async () => {
    const { key } = await saveImage(WS, TOPIC, PNG);
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const back = await readImage(WS, key);
    expect(back?.mimeType).toBe("image/png");
    expect(new Uint8Array(back!.data)).toEqual(PNG);
  });
});
