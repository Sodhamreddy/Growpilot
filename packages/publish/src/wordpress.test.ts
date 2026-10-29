import { describe, it, expect, vi, afterEach } from "vitest";
import { AppError } from "@ob/core";
import { wordPressTargetFingerprint, verifyConnection, createPost, type WordPressCredential } from "./wordpress.js";

/**
 * These exercise everything up to and including the HTTP boundary, with fetch
 * stubbed — no live site required. What matters most here is not the happy
 * path but the refusals: this is the one code path that carries a credential
 * equivalent to a login out to a customer-supplied address.
 */

const cred: WordPressCredential = {
  baseUrl: "https://example.com",
  username: "editor",
  applicationPassword: "abcd EFGH ijkl MNOP qrst UVWX",
};

function stubFetch(response: {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}) {
  const spy = vi.fn(async () =>
    new Response(response.text ?? JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: response.headers,
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = { id: 7, name: "Editor", capabilities: { publish_posts: true } };

describe("address handling", () => {
  it("refuses http — an application password must not travel in clear", async () => {
    await expect(
      verifyConnection({ ...cred, baseUrl: "http://example.com" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a private address", async () => {
    await expect(
      verifyConnection({ ...cred, baseUrl: "https://192.168.1.10" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses the cloud metadata address", async () => {
    await expect(
      verifyConnection({ ...cred, baseUrl: "https://169.254.169.254" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses localhost", async () => {
    await expect(
      verifyConnection({ ...cred, baseUrl: "https://127.0.0.1" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("builds the REST root from a bare site address", async () => {
    const spy = stubFetch({ body: ok });
    await verifyConnection(cred);
    expect(spy.mock.calls[0]?.[0]).toBe("https://example.com/wp-json/wp/v2/users/me?context=edit");
  });

  it("tolerates a trailing slash", async () => {
    const spy = stubFetch({ body: ok });
    await verifyConnection({ ...cred, baseUrl: "https://example.com/" });
    expect(spy.mock.calls[0]?.[0]).toContain("/wp-json/wp/v2/");
  });

  it("tolerates an address that already includes /wp-json", async () => {
    const spy = stubFetch({ body: ok });
    await verifyConnection({ ...cred, baseUrl: "https://example.com/wp-json" });
    expect(spy.mock.calls[0]?.[0]).toBe("https://example.com/wp-json/wp/v2/users/me?context=edit");
  });

  it("keeps a subdirectory install's path", async () => {
    const spy = stubFetch({ body: ok });
    await verifyConnection({ ...cred, baseUrl: "https://example.com/blog" });
    expect(spy.mock.calls[0]?.[0]).toBe("https://example.com/blog/wp-json/wp/v2/users/me?context=edit");
  });
});

describe("credentials", () => {
  it("strips the display spaces WordPress puts in application passwords", async () => {
    const spy = stubFetch({ body: ok });
    await verifyConnection(cred);
    const headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const decoded = Buffer.from(headers["Authorization"]!.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("editor:abcdEFGHijklMNOPqrstUVWX");
  });

  it("never follows a redirect, which could hand the credential to another host", async () => {
    const spy = stubFetch({ body: ok });
    await verifyConnection(cred);
    expect(spy.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("reports a redirect as a fixable address problem", async () => {
    stubFetch({ status: 301, headers: { location: "https://www.example.com/wp-json/wp/v2/users/me" } });
    await expect(verifyConnection(cred)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("verifyConnection", () => {
  it("returns the identity for a working credential", async () => {
    stubFetch({ body: ok });
    await expect(verifyConnection(cred)).resolves.toEqual({
      userId: 7, displayName: "Editor", canPublish: true,
    });
  });

  it("reports a read-only user as unable to publish", async () => {
    stubFetch({ body: { id: 7, name: "Subscriber", capabilities: { read: true } } });
    await expect(verifyConnection(cred)).resolves.toMatchObject({ canPublish: false });
  });

  it("treats 401 as a credential problem, not a retryable fault", async () => {
    stubFetch({ status: 401, body: { code: "invalid_username" } });
    await expect(verifyConnection(cred)).rejects.toMatchObject({
      code: "forbidden", retryable: false,
    });
  });

  it("explains an HTML response instead of failing to parse it", async () => {
    stubFetch({ status: 200, text: "<!doctype html><html>login</html>" });
    await expect(verifyConnection(cred)).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("treats a 5xx as retryable", async () => {
    stubFetch({ status: 503, body: { code: "unavailable" } });
    await expect(verifyConnection(cred)).rejects.toMatchObject({
      code: "dependency_unavailable", retryable: true,
    });
  });
});

describe("createPost", () => {
  const created = { id: 42, link: "https://example.com/?p=42", status: "draft" };

  it("sends rendered HTML, not markdown", async () => {
    const spy = stubFetch({ status: 201, body: created });
    await createPost(cred, { title: "T", bodyMarkdown: "## Heading\n\nBody.", slug: "t" });
    const body = JSON.parse(String(spy.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain("<h2>Heading</h2>");
    expect(body.content).not.toContain("##");
  });

  it("defaults to draft", async () => {
    const spy = stubFetch({ status: 201, body: created });
    await createPost(cred, { title: "T", bodyMarkdown: "Body.", slug: "t" });
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).status).toBe("draft");
  });

  it("derives an excerpt when none is given", async () => {
    const spy = stubFetch({ status: 201, body: created });
    await createPost(cred, { title: "T", bodyMarkdown: "# H\n\nOpening line.", slug: "t" });
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).excerpt).toBe("Opening line.");
  });

  it("refuses a scheduled post with no date", async () => {
    stubFetch({ status: 201, body: created });
    await expect(
      createPost(cred, { title: "T", bodyMarkdown: "B", slug: "t", status: "future" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("sends a scheduled date as GMT", async () => {
    const spy = stubFetch({ status: 201, body: created });
    await createPost(cred, {
      title: "T", bodyMarkdown: "B", slug: "t",
      status: "future", scheduledFor: new Date("2026-10-01T09:30:00.000Z"),
    });
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body)).date_gmt).toBe("2026-10-01T09:30:00");
  });

  it("returns the post id and link", async () => {
    stubFetch({ status: 201, body: created });
    await expect(createPost(cred, { title: "T", bodyMarkdown: "B", slug: "t" })).resolves.toEqual({
      externalId: "42", externalUrl: "https://example.com/?p=42", status: "draft",
    });
  });

  it("falls back to the edit screen when a draft has no public link", async () => {
    stubFetch({ status: 201, body: { id: 42, link: "", status: "draft" } });
    const result = await createPost(cred, { title: "T", bodyMarkdown: "B", slug: "t" });
    expect(result.externalUrl).toBe("https://example.com/wp-admin/post.php?post=42&action=edit");
  });

  it("fails loudly if WordPress returns no id", async () => {
    stubFetch({ status: 201, body: { status: "draft" } });
    await expect(
      createPost(cred, { title: "T", bodyMarkdown: "B", slug: "t" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("surfaces a WordPress validation message", async () => {
    stubFetch({ status: 400, body: { code: "empty_content", message: "Content and title are empty." } });
    await expect(
      createPost(cred, { title: "", bodyMarkdown: "", slug: "t" }),
    ).rejects.toMatchObject({ code: "validation_failed", retryable: false });
  });
});

vi.mock("@ob/seo", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ob/seo")>(),
  publicFetch: (url: string, init: RequestInit) => fetch(url, init),
}));


describe("uncertain WordPress writes", () => {
  it("does not automatically retry a POST whose response was lost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    await expect(createPost(cred, { title: "T", bodyMarkdown: "B", slug: "t" })).rejects.toMatchObject({ retryable: false, details: { outcomeUnknown: true } });
  });
  it("does not retry a server error after creating a post", async () => {
    stubFetch({ status: 502, body: { code: "upstream_failed" } });
    await expect(createPost(cred, { title: "T", bodyMarkdown: "B", slug: "t" })).rejects.toMatchObject({ retryable: false, details: { outcomeUnknown: true } });
  });
});

it("binds publication to the site while allowing password rotation", () => {
  const original = wordPressTargetFingerprint(cred);
  expect(wordPressTargetFingerprint({ ...cred, baseUrl: "https://example.com/wp-json/", applicationPassword: "rotated" })).toBe(original);
  expect(wordPressTargetFingerprint({ ...cred, baseUrl: "https://another.example.com" })).not.toBe(original);
  expect(wordPressTargetFingerprint({ ...cred, baseUrl: "https://example.com/other-site" })).not.toBe(original);
});
