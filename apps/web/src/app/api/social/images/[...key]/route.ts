export const dynamic = "force-dynamic";

import { requireTenant } from "@/lib/auth";
import { readImage } from "@/lib/image-store";

/**
 * GET /api/social/images/<workspaceId>/<file> — one stored post image.
 *
 * Behind sign-in, and only for the workspace the key names: a post's image is
 * unpublished work, and a guessable URL must not show it to anyone else.
 * Keys change with every new image, so a stored one never changes and can be
 * cached for good by the browser that was allowed to see it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }): Promise<Response> {
  let workspaceId: string;
  try {
    workspaceId = (await requireTenant()).workspaceId;
  } catch {
    return new Response("Sign in to see this image.", { status: 401 });
  }
  const { key } = await params;
  const image = await readImage(workspaceId, key.join("/"));
  if (!image) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(image.data), {
    headers: {
      "Content-Type": image.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
