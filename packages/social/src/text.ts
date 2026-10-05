/**
 * Length rules for post copy, and fitting an X post to X.
 *
 * No imports, on purpose: this is published as `@ob/social/text` so the
 * browser can use the same numbers and the same fitting as the writer,
 * without pulling in the AI gateway the package index brings with it.
 */

/**
 * The shared caption, one text for Instagram, Facebook and LinkedIn.
 *
 * Long enough to say one useful thing with its reason, short enough to be
 * read to the end on a phone. The planner this replaced asked for 150 to 290
 * words, which came out as essays nobody finished.
 */
export const CAPTION_WORDS = { min: 120, max: 200 } as const;

/** Instagram's ceiling for a caption, hashtags included. The tightest of the three. */
export const CAPTION_CHAR_LIMIT = 2200;

/** X's ceiling. Hashtags and spaces count towards it. */
export const X_LIMIT = 280;

/** Below this an X post is a slogan, not the caption's message. */
export const X_MIN = 100;

/**
 * The shape of a post's picture: tall for a reel's cover, square for podcast
 * art, 4:5 for everything in the feed (the tallest the feed shows uncropped).
 */
export function pictureRatio(format: string): "4:5" | "9:16" | "1:1" {
  if (format === "Video") return "9:16";
  if (format === "Podcast") return "1:1";
  return "4:5";
}

/**
 * The caption as it should be pasted into a network.
 *
 * Captions are edited with bold, italics and lists and stored as markdown,
 * but Instagram, LinkedIn and Facebook take plain text: pasted markdown would
 * arrive as literal asterisks. Lists keep a visible bullet, because a list
 * that loses its markers reads as a paragraph with odd line breaks.
 */
export function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/<\/?u>/g, "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/(^|[^*\w\\])\*(?!\s)(.+?)(?<!\s|\\)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^_\w\\])_(?!\s)(.+?)(?<!\s|\\)_(?!\w)/g, "$1$2")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    // The serializer escapes characters markdown would otherwise read as syntax.
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TAG = /#[\p{L}\p{N}_]+/gu;

/** The hashtags in a piece of text. */
export function hashtagsIn(text: string): string[] {
  return text.match(TAG) ?? [];
}

/**
 * Whole sentences from the start of `text`, as many as fit in `room`.
 * Empty when not even the first sentence fits.
 */
function wholeSentences(text: string, room: number): string {
  const sentences = text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g) ?? [text];
  let out = "";
  for (const s of sentences) {
    if ((out + s).trim().length > room) break;
    out += s;
  }
  return out.trim();
}

/** How many paragraphs a caption has, counting blank-line breaks. */
export function paragraphCount(text: string): number {
  return text.split(/\n\s*\n/).filter((p) => p.trim()).length;
}

/**
 * A caption that came back as one block, broken into short paragraphs.
 *
 * Models drop the blank lines inside a JSON string often enough to matter,
 * and a wall of text is what a phone reader scrolls past. Only a caption with
 * no line breaks at all is touched, and only at sentence ends, into 4 to 7
 * paragraphs of even length. Nothing is reworded.
 */
export function ensureParagraphs(text: string): string {
  if (/\n/.test(text)) return text;
  const sentences = (text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 4) return text;
  const count = Math.min(7, Math.max(4, Math.round(sentences.length / 2)), sentences.length);
  const paragraphs: string[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.round((i * sentences.length) / count);
    const to = Math.round(((i + 1) * sentences.length) / count);
    paragraphs.push(sentences.slice(from, to).join(" "));
  }
  return paragraphs.filter(Boolean).join("\n\n");
}

/**
 * An X post that fits in 280 characters without being cut mid-thought.
 *
 * Returned unchanged when it already fits. Otherwise, in order: drop trailing
 * hashtags down to one; then drop whole sentences from the end, keeping one
 * hashtag if it can; then without hashtags. A sentence is never cut in half,
 * so when even the first sentence is too long the post comes back as it was
 * and the length warning asks a person to rewrite it.
 */
export function fitToX(post: string, limit = X_LIMIT): string {
  const text = post.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;

  const trailing = /((?:\s+#[\p{L}\p{N}_]+)+)\s*$/u.exec(text);
  const body = (trailing ? text.slice(0, trailing.index) : text).trim();
  const tags = trailing ? trailing[1]!.trim().split(/\s+/) : [];
  const join = (b: string, t: string[]) => [b, ...t].filter(Boolean).join(" ");

  // Fewer hashtags first: they are the cheapest thing to lose.
  for (let keep = tags.length - 1; keep >= 1; keep--) {
    const out = join(body, tags.slice(0, keep));
    if (out.length <= limit) return out;
  }
  // Then whole sentences, with one hashtag if there is room, else none.
  for (const keep of tags.length ? [1, 0] : [0]) {
    const tagText = tags.slice(0, keep).join(" ");
    const fitted = wholeSentences(body, limit - (tagText ? tagText.length + 1 : 0));
    if (fitted) return join(fitted, tags.slice(0, keep));
  }
  return text;
}
