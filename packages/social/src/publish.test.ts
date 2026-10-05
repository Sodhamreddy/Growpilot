import { describe, it, expect, vi } from "vitest";
import type { PackSchedule, SocialContentPack } from "@ob/db";
import { publishBlocker, postText, publishScheduled, scheduleLock } from "./publish.js";
import { GraphError, publishFacebookPhoto, publishInstagramPhoto, grantedPermissions, describePublishError } from "./meta.js";

/**
 * Publishing to Facebook and Instagram.
 *
 * The one failure worse than not posting is posting twice, so the retry
 * behaviour is what these pin down: a network that already published is
 * never published to again.
 */

const pack: SocialContentPack = {
  caption: "**Floss** tonight.\n\nBleeding means start, not stop.",
  shortCaption: "Floss tonight. #GumHealth",
  hashtags: ["#GumHealth", "#NorthsideDental"],
  imageBrief: "", aiPrompt: "", altText: "", formatExtra: "",
  image: { key: "k", mimeType: "image/png", source: "generated", status: "approved", createdAt: "2026-09-29T00:00:00Z" },
};
const schedule: PackSchedule = { at: "2026-10-05T04:30:00Z", networks: ["facebook", "instagram"], status: "scheduled", results: {} };
const ok = (id: string) => async () => ({ id, url: `https://example.com/${id}` });

describe("what may publish", () => {
  const post = { status: "approved", format: "Static Image", pack };

  it("allows an approved post with an approved image", () => {
    expect(publishBlocker(post)).toBeNull();
  });

  it("names the step still to do", () => {
    expect(publishBlocker({ ...post, status: "written" })).toMatch(/step 3/);
    expect(publishBlocker({ ...post, pack: { ...pack, image: undefined } })).toMatch(/step 4/);
    expect(publishBlocker({ ...post, pack: { ...pack, image: { ...pack.image!, status: "draft" } } })).toMatch(/Approve its image/);
  });

  it("refuses formats whose media this tool does not make", () => {
    expect(publishBlocker({ ...post, format: "Carousel" })).toMatch(/every slide/);
    expect(publishBlocker({ ...post, format: "Video" })).toMatch(/video post needs its media/);
  });
});

describe("what a schedule holds back", () => {
  it("locks a post while it waits to publish", () => {
    expect(scheduleLock({ ...pack, schedule })).toMatch(/Unschedule it in step 5/);
    expect(scheduleLock({ ...pack, schedule: { ...schedule, status: "publishing" } })).toMatch(/Unschedule/);
  });

  it("locks for good once any network has it", () => {
    const partial: PackSchedule = {
      ...schedule, status: "partial",
      results: { facebook: { status: "published", id: "1", url: "u", at: "t" }, instagram: { status: "failed", error: "x", at: "t" } },
    };
    expect(scheduleLock({ ...pack, schedule: partial })).toMatch(/already published/);
  });

  it("frees a post that is not scheduled, or whose schedule published nothing", () => {
    expect(scheduleLock(pack)).toBeNull();
    expect(scheduleLock(null)).toBeNull();
    expect(scheduleLock({ ...pack, schedule: { ...schedule, status: "failed" } })).toBeNull();
  });
});

describe("the text each network gets", () => {
  it("is the caption as plain text with the hashtags after it", () => {
    expect(postText(pack)).toBe("Floss tonight.\n\nBleeding means start, not stop.\n\n#GumHealth #NorthsideDental");
  });
});

describe("publishing a schedule", () => {
  it("publishes to both networks and records where", async () => {
    const res = await publishScheduled(pack, schedule, { facebook: ok("fb1"), instagram: ok("ig1") });
    expect(res.schedule.status).toBe("published");
    expect(res.schedule.results.facebook).toMatchObject({ status: "published", id: "fb1" });
    expect(res.schedule.results.instagram).toMatchObject({ status: "published", id: "ig1" });
    expect(res.retry).toBe(false);
  });

  it("never publishes again where it already succeeded", async () => {
    const facebook = vi.fn(ok("fb2"));
    const done: PackSchedule = { ...schedule, results: { facebook: { status: "published", id: "fb1", at: "x" } } };
    const res = await publishScheduled(pack, done, { facebook, instagram: ok("ig1") });
    expect(facebook).not.toHaveBeenCalled();
    expect(res.schedule.results.facebook?.id).toBe("fb1");
    expect(res.schedule.status).toBe("published");
  });

  it("keeps a Facebook success when Instagram fails, and retries only a transient failure", async () => {
    const transient = await publishScheduled(pack, schedule, {
      facebook: ok("fb1"),
      instagram: async () => { throw new GraphError({ message: "Rate limited, try later.", permanent: false }); },
    });
    expect(transient.schedule.status).toBe("partial");
    expect(transient.schedule.results.instagram).toMatchObject({ status: "failed", error: "Rate limited, try later." });
    expect(transient.retry).toBe(true);

    const permanent = await publishScheduled(pack, schedule, {
      facebook: ok("fb1"),
      instagram: async () => { throw new GraphError({ message: "Missing permission.", permanent: true }); },
    });
    expect(permanent.retry).toBe(false);
  });
});

describe("the Graph calls", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("posts a Page photo as the file itself and returns the post link", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/page1\/photos$/);
      const form = init!.body as FormData;
      expect(form.get("message")).toBe("Hello");
      expect(form.get("source")).toBeInstanceOf(Blob);
      return json({ id: "photo1", post_id: "page1_post9" });
    });
    const res = await publishFacebookPhoto({ id: "page1", accessToken: "t" },
      { message: "Hello", image: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" }, fetcher as never);
    expect(res).toEqual({ id: "page1_post9", url: "https://www.facebook.com/page1_post9" });
  });

  it("publishes to Instagram in two steps, waiting for processing", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname.endsWith("/ig1/media")) return json({ id: "c1" });
      if (u.pathname.endsWith("/c1")) return json({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" });
      if (u.pathname.endsWith("/ig1/media_publish")) return json({ id: "m1" });
      if (u.pathname.endsWith("/m1")) return json({ permalink: "https://www.instagram.com/p/abc/" });
      return json({ error: { message: "unexpected" } }, 400);
    });
    const res = await publishInstagramPhoto({ instagramId: "ig1", accessToken: "t" },
      { caption: "Hi", imageUrl: "https://cdn.example/x.jpg" }, fetcher as never, async () => {});
    expect(res).toEqual({ id: "m1", url: "https://www.instagram.com/p/abc/" });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(2);
  });

  it("does not retry a post that may have gone out", async () => {
    const timeout = vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); });
    const err = await publishFacebookPhoto({ id: "page1", accessToken: "t" },
      { message: "Hello", image: new Uint8Array([1]), mimeType: "image/png" }, timeout as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).permanent).toBe(true);
    expect((err as GraphError).message).toMatch(/may or may not have gone out/);
  });

  it("explains a refusal in terms of posting, and retries only Meta's own trouble", () => {
    expect(describePublishError({ error: { code: 200, message: "Permissions error" } })).toMatchObject({
      permanent: true, message: expect.stringMatching(/not allowed this app to post/),
    });
    expect(describePublishError({ error: { code: 190 } }).permanent).toBe(true);
    expect(describePublishError({ error: { code: 4 } }).permanent).toBe(false);
    expect(describePublishError({ error: { code: 2, is_transient: true } }).permanent).toBe(false);
    expect(describePublishError({}, 503).permanent).toBe(false);
    expect(describePublishError({ error: { code: 100, error_user_msg: "The image is too small." } })).toEqual({
      permanent: true, message: "Meta refused the post: The image is too small.",
    });
  });

  it("reads the granted permissions only", async () => {
    const fetcher = vi.fn(async () => json({ data: [
      { permission: "pages_manage_posts", status: "granted" },
      { permission: "instagram_content_publish", status: "declined" },
    ] }));
    expect(await grantedPermissions("t", fetcher as never)).toEqual(["pages_manage_posts"]);
  });
});
