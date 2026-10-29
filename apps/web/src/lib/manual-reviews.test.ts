import { describe, expect, it } from "vitest";
import { manualReviewId, manualReviewSchema, parseManualReviewsCsv } from "./manual-reviews";

describe("manual reviews", () => {
  it("imports quoted, multiline comments with escaped quotes and Windows line endings", () => {
    const reviews = parseManualReviewsCsv('authorName,rating,publishedAt,comment\r\n"Sam, S",5,2026-10-01,"Good\n""service"""\r\n');
    expect(reviews).toEqual([{ authorName: "Sam, S", rating: 5, publishedAt: "2026-10-01", comment: 'Good\n"service"', reviewUrl: "" }]);
  });
  it("deduplicates reimports regardless of casing, spacing, or optional link", () => {
    const review = manualReviewSchema.parse({ authorName: "SAM", rating: 5, comment: "Good  service", publishedAt: "2026-10-01" });
    expect(manualReviewId(review)).toBe(manualReviewId({ ...review, authorName: "sam", comment: "good service", reviewUrl: "https://example.com" }));
    expect(manualReviewId(review)).not.toBe(manualReviewId({ ...review, publishedAt: "2026-10-02" }));
  });
  it("rejects impossible dates, unsafe links, invalid ratings and malformed CSV", () => {
    expect(() => parseManualReviewsCsv("authorName,rating,publishedAt\nSam,5,2026-02-30")).toThrow("Row 2");
    expect(() => parseManualReviewsCsv("authorName,rating,publishedAt,reviewUrl\nSam,5,2026-02-01,javascript:alert(1)")).toThrow();
    expect(() => parseManualReviewsCsv("authorName,rating,publishedAt\nSam,6,2026-02-01")).toThrow();
    expect(() => parseManualReviewsCsv('authorName,rating,publishedAt\n"Sam,5,2026-02-01')).toThrow("not closed");
    expect(() => parseManualReviewsCsv("wrong,headers\nSam,5")).toThrow("headers");
  });
  it("bounds batch size before any reviews are saved", () => {
    expect(() => parseManualReviewsCsv("authorName,rating,publishedAt\n" + "Sam,5,2026-02-01\n".repeat(201))).toThrow("200");
  });
});
