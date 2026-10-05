/**
 * Post images, as the web app uses them.
 *
 * The store itself lives in @ob/social (see store.ts there) because the
 * worker publishes and must read the same images. This adds the one thing
 * only the browser needs: the address images are fetched from, which goes
 * through a signed-in route whichever store holds the file.
 */
export { saveImage, readImage, deleteImage, sniffImageType, MAX_IMAGE_BYTES } from "@ob/social";

/** Where the browser fetches an image from. */
export const imageUrl = (key: string) => `/api/social/images/${key}`;
