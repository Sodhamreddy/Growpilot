/**
 * Post text helpers that are safe to import in the browser.
 *
 * @ob/social holds the real rules but its index pulls in the AI gateway, so
 * anything a client component needs lives here instead.
 */

/** Formats a post can take. Mirrors FORMATS in @ob/social. */
export const SOCIAL_FORMATS = [
  "Static Image", "Carousel", "Video", "Quote", "Q and A", "Poll/Quiz", "Podcast", "GIF",
] as const;

/**
 * What the pack's picture is, for a given format.
 *
 * Only a static post has a "post image". A video has a cover frame, the still
 * the feed shows before anyone presses play; a carousel has a cover slide; a
 * podcast has cover art. Same fields in the pack, different job, so the
 * dialog names the job rather than calling a reel's cover an image.
 */
export function pictureFor(format: string): { title: string; hint: string | null; brief: string; briefFor: string } {
  switch (format) {
    case "Video":
      return {
        title: "Cover — the title on the video's cover frame",
        hint: "The still Instagram, Facebook and LinkedIn show in the feed before the video plays.",
        brief: "Cover brief and alt text",
        briefFor: "for the video's cover frame",
      };
    case "Podcast":
      return {
        title: "Cover — the title on the episode's cover art",
        hint: "The square shown with the episode wherever it is shared.",
        brief: "Cover brief and alt text",
        briefFor: "for the episode's cover art",
      };
    case "Carousel":
      return {
        title: "Cover slide — the text on the first slide",
        hint: "The slide the feed shows. The rest are under Carousel slides.",
        brief: "Cover slide brief and alt text",
        briefFor: "for whoever makes the slides",
      };
    default:
      return {
        title: "Image content — the text on the post image",
        hint: null,
        brief: "Image brief and alt text",
        briefFor: "for whoever makes the image",
      };
  }
}

export { markdownToPlain } from "@ob/social/text";
