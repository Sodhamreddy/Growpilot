import { AppError } from "@ob/core";

const MAX_BYTES = 1_048_576;

/** Bound both streamed bytes and validation work, including chunked requests. */
export async function readRequestJson(req: Request, maxBytes = MAX_BYTES): Promise<unknown> {
  const reject = () => new AppError("validation_failed", "The request is too large or complex. Send fewer items at a time.");
  if (Number(req.headers.get("content-length")) > maxBytes) throw reject();
  const reader = req.body?.getReader();
  if (!reader) throw new AppError("validation_failed", "The request body must be valid JSON.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw reject(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AppError("validation_failed", "The request body must be valid JSON."); }
  const stack = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++nodes > 20_000 || entry.depth > 32) throw reject();
    if (entry.value && typeof entry.value === "object") {
      const values = Object.values(entry.value);
      if (values.length > 2_000) throw reject();
      for (const value of values) stack.push({ value, depth: entry.depth + 1 });
    }
  }
  return raw;
}
