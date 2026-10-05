import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AppError } from "@ob/core";

/**
 * Where post images live.
 *
 * Supabase Storage when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
 * otherwise files on this machine's disk. The difference that matters is
 * reach: Instagram fetches the image it publishes from a public address, so
 * only Supabase Storage lets a post go to Instagram. Facebook takes the file
 * itself, so it works from either.
 *
 * Here rather than in the web app because the worker publishes, and it has to
 * read the same images the web app saved. The local folder is therefore one
 * folder for the whole repository (IMAGE_STORE_DIR, or `.image-store` at the
 * root), not one per app.
 *
 * The bucket is public, so names carry a random part: an unpublished post's
 * picture is reachable only by someone who already has its full address.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^(${UUID})/(${UUID})-(\\d+)(?:-[0-9a-f]{24})?(?:\\.ig)?\\.(png|jpg|webp)$`);
const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** Largest image accepted. A 1080×1350 PNG is well under this. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ─── Which store ─────────────────────────────────────────────────────────────

interface Supabase { url: string; key: string; bucket: string }

function supabase(): Supabase | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key, bucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || "post-images" };
}

/** "supabase" when images have a public address, "local" when they do not. */
export function storageKind(): "supabase" | "local" {
  return supabase() ? "supabase" : "local";
}

/**
 * The shared local folder: IMAGE_STORE_DIR, else `.image-store` at the root of
 * the repository, found by walking up to pnpm-workspace.yaml. The web app and
 * the worker run from different folders, and must still see the same files.
 */
function localRoot(): string {
  if (process.env.IMAGE_STORE_DIR) return path.resolve(process.env.IMAGE_STORE_DIR);
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.join(dir, ".image-store");
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(process.cwd(), ".image-store");
}

// ─── Supabase Storage over its REST API ──────────────────────────────────────

let bucketReady: Promise<void> | null = null;

/** Create the bucket once per process; an existing one is fine. */
function ensureBucket(s: Supabase): Promise<void> {
  bucketReady ??= (async () => {
    const res = await fetch(`${s.url}/storage/v1/bucket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.key}`, apikey: s.key, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: s.bucket, name: s.bucket, public: true,
        file_size_limit: MAX_IMAGE_BYTES, allowed_mime_types: Object.keys(EXTENSION),
      }),
    });
    if (!res.ok && res.status !== 409 && !/already exists/i.test(await res.text().catch(() => ""))) {
      bucketReady = null;
      throw new AppError("dependency_unavailable", "Could not prepare image storage in Supabase. Check the service-role key.", {
        details: { status: res.status }, retryable: true,
      });
    }
  })();
  return bucketReady;
}

async function supabasePut(s: Supabase, key: string, data: Uint8Array, mimeType: string): Promise<void> {
  await ensureBucket(s);
  const res = await fetch(`${s.url}/storage/v1/object/${s.bucket}/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.key}`, apikey: s.key, "Content-Type": mimeType, "x-upsert": "true" },
    body: data,
  });
  if (!res.ok) {
    throw new AppError("dependency_unavailable", "The image could not be saved to Supabase Storage.", {
      details: { status: res.status }, retryable: true,
    });
  }
}

// ─── The store ───────────────────────────────────────────────────────────────

/**
 * The image type from the file's own first bytes.
 *
 * The browser's claimed type is not trusted: a file named photo.png can hold
 * anything, and these are served back to every member of the workspace.
 */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Save an image and return its key. */
export async function saveImage(workspaceId: string, topicId: string, data: Uint8Array): Promise<{ key: string; mimeType: string }> {
  const mimeType = sniffImageType(data);
  if (!mimeType) {
    throw new AppError("validation_failed", "That file is not a PNG, JPEG or WebP image.", { retryable: false });
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new AppError("validation_failed", "That image is over 8 MB. Export it smaller and try again.", { retryable: false });
  }
  const key = `${workspaceId}/${topicId}-${Date.now()}-${randomBytes(12).toString("hex")}.${EXTENSION[mimeType]}`;
  await put(key, data, mimeType);
  return { key, mimeType };
}

async function put(key: string, data: Uint8Array, mimeType: string): Promise<void> {
  const s = supabase();
  if (s) return supabasePut(s, key, data, mimeType);
  const file = path.join(localRoot(), key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** Read an image, or null when the key is malformed, foreign or missing. */
export async function readImage(workspaceId: string, key: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const m = KEY.exec(key);
  if (!m || m[1] !== workspaceId) return null;
  const mimeType = MIME[m[4]!]!;
  const s = supabase();
  if (s) {
    const res = await fetch(`${s.url}/storage/v1/object/${s.bucket}/${key}`, {
      headers: { Authorization: `Bearer ${s.key}`, apikey: s.key },
    }).catch(() => null);
    if (res?.ok) return { data: Buffer.from(await res.arrayBuffer()), mimeType };
    // Not there: it may be from before Supabase was set up, when images were
    // kept on disk. Those still publish, Instagram included, since its copy
    // is uploaded fresh.
  }
  try {
    return { data: await readFile(path.join(localRoot(), key)), mimeType };
  } catch {
    return null;
  }
}

/** Remove a replaced image. Best effort: a leftover file costs space, not correctness. */
export async function deleteImage(workspaceId: string, key: string): Promise<void> {
  if (KEY.exec(key)?.[1] !== workspaceId) return;
  const s = supabase();
  const keys = [key, key.replace(/\.(png|jpg|webp)$/, ".ig.jpg")];
  if (s) {
    await fetch(`${s.url}/storage/v1/object/${s.bucket}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${s.key}`, apikey: s.key, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: keys }),
    }).catch(() => undefined);
    return;
  }
  for (const k of keys) await unlink(path.join(localRoot(), k)).catch(() => undefined);
}

/** The image's public address, when the store gives it one. */
export function publicImageUrl(key: string): string | null {
  const s = supabase();
  return s ? `${s.url}/storage/v1/object/public/${s.bucket}/${key}` : null;
}

/**
 * A public JPEG of the image, for Instagram.
 *
 * Instagram publishes JPEG only, fetches it from a URL itself, and wants it no
 * wider than 1440 pixels. The model returns PNG, so a JPEG copy is made next
 * to the original, flattened onto white in case it has transparency. Null
 * when the store has no public address, which is the caller's cue to say that
 * Instagram needs Supabase Storage.
 */
export async function instagramJpegUrl(workspaceId: string, key: string): Promise<string | null> {
  if (!supabase()) return null;
  const original = await readImage(workspaceId, key);
  if (!original) {
    throw new AppError("not_found", "The post's image is missing from storage. Generate or upload it again.", {
      retryable: false,
    });
  }
  const { default: sharp } = await import("sharp");
  const jpeg = await sharp(original.data)
    .resize({ width: 1440, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  const igKey = key.replace(/\.(png|jpg|webp)$/, ".ig.jpg");
  await put(igKey, jpeg, "image/jpeg");
  return publicImageUrl(igKey);
}
