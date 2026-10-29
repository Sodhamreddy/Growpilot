import { createHash } from "node:crypto";
import { z } from "zod";

export const manualReviewSchema = z.object({
  authorName: z.string().trim().min(1).max(200),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(10000).default(""),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }, "Use a real date in YYYY-MM-DD format."),
  reviewUrl: z.union([z.literal(""), z.string().url().max(2000).refine((v) => new URL(v).protocol === "https:", "Use an HTTPS review link.")]).default(""),
});

export function manualReviewId(review: z.infer<typeof manualReviewSchema>): string {
  const clean = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return `manual-${createHash("sha256").update(JSON.stringify([
    clean(review.authorName), review.rating, clean(review.comment), review.publishedAt,
  ])).digest("hex")}`;
}

/** Small bounded CSV reader, including escaped quotes and multiline comments. */
export function parseManualReviewsCsv(csv: string): z.infer<typeof manualReviewSchema>[] {
  if (csv.length > 1_000_000) throw new Error("The CSV must be smaller than 1 MB.");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell.length) quoted = !quoted;
      else throw new Error("Unexpected quote in the CSV.");
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(cell); cell = "";
      if (c !== ",") {
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (c === "\r" && csv[i + 1] === "\n") i++;
        if (rows.length > 201) throw new Error("Import at most 200 reviews at once.");
      }
    } else cell += c;
  }
  if (quoted) throw new Error("A quoted CSV field is not closed.");
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  const header = rows.shift()?.map((s) => s.replace(/^\uFEFF/, "").trim()) ?? [];
  if (!["authorName", "rating", "publishedAt"].every((key) => header.includes(key))) {
    throw new Error("CSV headers must include authorName, rating, and publishedAt. Optional: comment, reviewUrl.");
  }
  if (!rows.length || rows.length > 200) throw new Error("Import between 1 and 200 reviews at once.");
  return rows.map((values, i) => {
    const result = manualReviewSchema.safeParse(Object.fromEntries(header.map((key, j) => [key, values[j] ?? ""])));
    if (!result.success) throw new Error(`Row ${i + 2}: ${result.error.issues[0]?.message ?? "Invalid review"}`);
    return result.data;
  });
}
