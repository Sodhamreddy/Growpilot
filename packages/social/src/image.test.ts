import { describe, it, expect, vi } from "vitest";
import { buildImageRequest, generatePostImage, pictureSpec, type ImageInput } from "./image.js";

/**
 * What the image model is asked for.
 *
 * The text on the image is the part a person will check letter by letter,
 * so the request has to carry it once, exactly, and forbid anything else.
 */

const input: ImageInput = {
  businessName: "Northside Dental",
  format: "Static Image",
  imageText: "**Floss** tonight\n\nBleeding means start, not stop.",
  imageBrief: 'A bathroom sink at night, warm light. Brand blue band at the bottom. Cover headline "Floss tonight" with subline "Bleeding means start, not stop."',
  brandColors: ["#1f6fe8 (primary)"],
};

describe("the image request", () => {
  it("carries the headline and subline exactly, as plain text", () => {
    const { prompt } = buildImageRequest(input);
    expect(prompt).toContain('Headline: "Floss tonight"');
    expect(prompt).toContain('Subline: "Bleeding means start, not stop."');
    expect(prompt).toContain("no other words");
  });

  it("does not repeat the brief's own overlay line", () => {
    const { prompt } = buildImageRequest(input);
    expect(prompt).not.toMatch(/Cover headline/);
    expect(prompt).toContain("A bathroom sink at night");
  });

  it("asks for no words when there is no image text", () => {
    expect(buildImageRequest({ ...input, imageText: "" }).prompt).toContain("Put no words on the image at all.");
  });

  it("uses the brand colours and forbids logos", () => {
    const { prompt } = buildImageRequest(input);
    expect(prompt).toContain("#1f6fe8 (primary)");
    expect(prompt).toMatch(/No logos/);
  });

  it("adds a reviewer's direction for this attempt only", () => {
    expect(buildImageRequest({ ...input, direction: "Make it brighter." }).prompt).toMatch(/EXTRA DIRECTION[\s\S]*Make it brighter\./);
  });

  it("shapes the picture for the format", () => {
    expect(pictureSpec("Video")).toMatchObject({ aspectRatio: "9:16" });
    expect(pictureSpec("Podcast")).toMatchObject({ aspectRatio: "1:1" });
    expect(pictureSpec("Carousel")).toMatchObject({ aspectRatio: "4:5" });
    expect(pictureSpec("Quote").aspectRatio).toBe("4:5");
    expect(buildImageRequest({ ...input, format: "Video" }).prompt).toMatch(/video cover frame/);
  });
});

describe("generating the image", () => {
  it("sends the built request through the gateway and returns the prompt with the image", async () => {
    const generateImage = vi.fn().mockResolvedValue({ data: new Uint8Array([1]), mimeType: "image/png", provider: "google", model: "m" });
    const res = await generatePostImage({ generateImage } as never, { workspaceId: "w" } as never, input);
    const call = generateImage.mock.calls[0]![1];
    expect(call.aspectRatio).toBe("4:5");
    expect(call.prompt).toBe(res.prompt);
  });
});
