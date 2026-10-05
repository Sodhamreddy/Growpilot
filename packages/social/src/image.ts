import type { TenantContext } from "@ob/core";
import type { Gateway, ImageResponse } from "@ob/ai";
import { PROMPT_VERSIONS } from "@ob/ai";
import { markdownToPlain, pictureRatio } from "./text.js";

/**
 * Step 4: the post's picture, made from its approved copy.
 *
 * Everything the picture needs is already in the pack: the words printed on
 * it (image text), what it shows and how it is laid out (image brief), and
 * the brand colours. This turns that into one request for the image model,
 * shaped for the format.
 *
 * The model renders the text itself. That is why the step exists as a review
 * rather than a button: a misspelt headline is caught by a person comparing
 * the picture with the text beside it, and the fix is to generate again.
 */

export interface ImageInput {
  businessName: string;
  format: string;
  /** "Headline\n\nSubline", as markdown from the editor. */
  imageText: string;
  imageBrief: string;
  /** "#46C8F5 (primary)". */
  brandColors: string[];
  /** A reviewer's extra instruction for this attempt. Not saved to the pack. */
  direction?: string;
}

/** What the picture is for, and the shape it has to be, per format. */
export function pictureSpec(format: string): { kind: string; aspectRatio: string } {
  const aspectRatio = pictureRatio(format);
  switch (format) {
    case "Video": return { kind: "vertical video cover frame (the still shown before the video plays)", aspectRatio };
    case "Podcast": return { kind: "square podcast episode cover", aspectRatio };
    case "Carousel": return { kind: "carousel cover slide", aspectRatio };
    default: return { kind: "feed post image", aspectRatio };
  }
}

/** The request for the image model. Pure, so it can be read and tested. */
export function buildImageRequest(input: ImageInput): { prompt: string; aspectRatio: string } {
  const { kind, aspectRatio } = pictureSpec(input.format);
  const [headline = "", ...rest] = markdownToPlain(input.imageText).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const subline = rest.join(" ");

  const text = headline
    ? [
        "TEXT ON THE IMAGE",
        "Render exactly this text, spelled exactly as written, and no other words anywhere in the image:",
        `  Headline: "${headline}"`,
        subline ? `  Subline: "${subline}"` : "",
        "Large, legible and high contrast against what is behind it. Headline clearly bigger than the subline.",
      ]
    : ["TEXT ON THE IMAGE", "Put no words on the image at all."];

  const prompt = [
    `Create a finished social media ${kind} for ${input.businessName}, ${aspectRatio}.`,
    "",
    "WHAT IT SHOWS AND HOW IT IS LAID OUT",
    // The brief's own overlay line would state the text a second time, in a
    // form the model might render twice. The text block above is the one copy.
    input.imageBrief.replace(/Cover headline\s*:?\s*["“][^"”]*["”](\s*with subline\s*["“][^"”]*["”])?\.?/i, "").trim(),
    "",
    ...text.filter(Boolean),
    "",
    "BRAND",
    input.brandColors.length
      ? `Use these brand colours for the layout and type: ${input.brandColors.join(", ")}.`
      : "Use a restrained palette of two or three colours.",
    "No logos, no watermarks, no signatures, no brand names beyond the text above, no fake app interface.",
    "",
    "QUALITY",
    "Photographic and believable unless the brief asks otherwise. People look natural and unposed, with correct hands and faces.",
    "Nothing in the picture contradicts the text.",
    input.direction?.trim() ? `\nEXTRA DIRECTION FROM THE REVIEWER\n${input.direction.trim()}` : "",
  ].filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return { prompt, aspectRatio };
}

export async function generatePostImage(
  gateway: Gateway,
  ctx: TenantContext,
  input: ImageInput,
): Promise<ImageResponse & { prompt: string }> {
  const { prompt, aspectRatio } = buildImageRequest(input);
  const res = await gateway.generateImage(ctx, { prompt, aspectRatio, promptVersion: PROMPT_VERSIONS.socialImage });
  return { ...res, prompt };
}
