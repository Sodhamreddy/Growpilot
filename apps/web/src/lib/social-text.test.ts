import { describe, it, expect } from "vitest";
import { markdownToPlain, pictureFor } from "./social-text";

describe("what a post's picture is called", () => {
  it("calls a video's picture its cover frame, not a post image", () => {
    expect(pictureFor("Video").title).toMatch(/cover frame/);
    expect(pictureFor("Video").title).not.toMatch(/post image/);
  });

  it("calls a carousel's picture its cover slide", () => {
    expect(pictureFor("Carousel").title).toMatch(/first slide/);
  });

  it("keeps the post image for static formats", () => {
    for (const f of ["Static Image", "Quote", "Q and A", "Poll/Quiz", "GIF"]) {
      expect(pictureFor(f).title).toBe("Image content — the text on the post image");
    }
  });
});

describe("copying a caption as plain text", () => {
  it("drops bold, italic and underline marks and keeps the words", () => {
    expect(markdownToPlain("**Floss** tonight, *gently*, and <u>every</u> night.")).toBe(
      "Floss tonight, gently, and every night.",
    );
  });

  it("turns bullet lists into visible bullets and leaves numbered lists alone", () => {
    expect(markdownToPlain("Two things:\n\n- Floss\n- Rinse\n\n1. Book\n2. Come in")).toBe(
      "Two things:\n\n• Floss\n• Rinse\n\n1. Book\n2. Come in",
    );
  });

  it("removes the escapes the markdown writer adds", () => {
    expect(markdownToPlain("1990\\. The UN named today\\.\n\n\\#NotAHeading and 3 \\* 4")).toBe(
      "1990. The UN named today.\n\n#NotAHeading and 3 * 4",
    );
  });

  it("keeps paragraphs and hashtags and leaves plain text unchanged", () => {
    const plain = "The UN did not create this day to ask anyone to be nicer.\n\nAsk about the future. #OlderPersons";
    expect(markdownToPlain(plain)).toBe(plain);
  });

  it("does not eat underscores inside words", () => {
    expect(markdownToPlain("see snake_case_name here")).toBe("see snake_case_name here");
  });
});
