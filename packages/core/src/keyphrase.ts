/**
 * Keyphrase matching that reads text the way search engines do.
 *
 * Keyword research returns targets with the small connecting words removed,
 * such as "payment options in-home senior care ann arbor". Natural English never
 * contains that string ("payment options for in-home senior care in Ann Arbor"),
 * so an exact substring test marked every well-written article as missing its
 * keyword and no edit could raise the score.
 *
 * Here case, punctuation, hyphens, possessives, simple plurals and short
 * function words are ignored on both sides. The keyphrase's main words must
 * still appear together and in the same order.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "for", "in", "of", "on", "to", "at", "by", "with", "from", "into", "about",
  "your", "our", "their", "its", "is", "are",
]);

/** The words that carry a phrase's meaning, normalised for matching. */
export function keyphraseWords(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/['’]s\b/g, "").replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !FUNCTION_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/** Link targets and bare URLs are not reader-visible text, so they never count as a use. */
const visibleText = (text: string) => text.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ");

/** How many times the keyphrase is used in the text. */
export function countKeyphrase(text: string, keyphrase: string): number {
  const target = keyphraseWords(keyphrase);
  if (!target.length) {
    // A phrase made only of function words has nothing to normalise: search for it as written.
    const needle = keyphrase.trim().toLowerCase();
    return needle ? visibleText(text).toLowerCase().split(needle).length - 1 : 0;
  }
  const words = keyphraseWords(visibleText(text));
  let count = 0;
  for (let at = 0; at + target.length <= words.length; at++) {
    if (target.every((word, offset) => words[at + offset] === word)) { count++; at += target.length - 1; }
  }
  return count;
}

export function containsKeyphrase(text: string | null | undefined, keyphrase: string): boolean {
  return Boolean(text) && countKeyphrase(text!, keyphrase) > 0;
}
