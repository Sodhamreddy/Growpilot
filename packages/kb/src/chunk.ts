/**
 * Document chunking for the knowledge base — spec §4.
 *
 * Splits on heading and paragraph boundaries rather than a fixed character
 * window, so a retrieved chunk is a coherent passage a model can cite. Each
 * chunk carries the heading it sits under, which becomes part of the evidence
 * label shown in the prompt (spec §4.1).
 */

export interface Chunk {
  heading: string | null;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target size in tokens. Chunks may exceed this only for an unsplittable paragraph. */
  targetTokens?: number;
  /** Overlap carried between adjacent chunks, in tokens. */
  overlapTokens?: number;
  minTokens?: number;
}

/** ~4 characters per token — adequate for sizing, not for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 400;
  const overlap = opts.overlapTokens ?? 50;
  const min = opts.minTokens ?? 30;

  const blocks = splitIntoBlocks(text);
  const chunks: Chunk[] = [];

  let current: string[] = [];
  let currentTokens = 0;
  let currentHeading: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    const content = current.join("\n\n").trim();
    if (estimateTokens(content) >= min) {
      chunks.push({ heading: currentHeading, content, tokenCount: estimateTokens(content) });
    }
    current = [];
    currentTokens = 0;
  };

  for (const block of blocks) {
    if (block.isHeading) {
      // A heading starts a new section; never straddle one.
      flush();
      currentHeading = block.text;
      continue;
    }

    const blockTokens = estimateTokens(block.text);

    // A single oversized paragraph is split on sentence boundaries.
    if (blockTokens > target * 1.5) {
      flush();
      for (const piece of splitLongBlock(block.text, target)) {
        chunks.push({ heading: currentHeading, content: piece, tokenCount: estimateTokens(piece) });
      }
      continue;
    }

    if (currentTokens + blockTokens > target && current.length > 0) {
      const tail = overlap > 0 ? takeTail(current, overlap) : [];
      flush();
      current = [...tail];
      currentTokens = tail.reduce((n, t) => n + estimateTokens(t), 0);
    }

    current.push(block.text);
    currentTokens += blockTokens;
  }

  flush();
  return chunks;
}

interface Block {
  text: string;
  isHeading: boolean;
}

function splitIntoBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split(/\n{2,}/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (headingMatch?.[1]) {
      blocks.push({ text: headingMatch[1].trim(), isHeading: true });
    } else {
      blocks.push({ text: trimmed.replace(/\s+/g, " "), isHeading: false });
    }
  }
  return blocks;
}

function splitLongBlock(text: string, targetTokens: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buffer: string[] = [];
  let tokens = 0;

  for (const sentence of sentences) {
    const t = estimateTokens(sentence);
    if (tokens + t > targetTokens && buffer.length > 0) {
      out.push(buffer.join(" ").trim());
      buffer = [];
      tokens = 0;
    }
    buffer.push(sentence);
    tokens += t;
  }
  if (buffer.length > 0) out.push(buffer.join(" ").trim());
  return out.filter((s) => s.length > 0);
}

function takeTail(blocks: string[], overlapTokens: number): string[] {
  const tail: string[] = [];
  let tokens = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const t = estimateTokens(block);
    if (tokens + t > overlapTokens) break;
    tail.unshift(block);
    tokens += t;
  }
  return tail;
}

/** Build chunks from a crawled page, prefixing the title for context. */
export function chunkPage(page: {
  title: string | null;
  headings: { level: number; text: string }[];
  text: string;
}, opts?: ChunkOptions): Chunk[] {
  // Reconstruct a markdown-ish outline so chunking can see section boundaries.
  let reconstructed = page.text;
  for (const h of page.headings) {
    if (h.text.length < 3) continue;
    reconstructed = reconstructed.replace(
      h.text,
      `\n\n${"#".repeat(Math.min(6, h.level))} ${h.text}\n\n`,
    );
  }
  const chunks = chunkText(reconstructed, opts);
  return chunks.map((c) => ({ ...c, heading: c.heading ?? page.title }));
}
