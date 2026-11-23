import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleCommentsPanel, useArticleComments, type ArticleComment, type ArticleCommentsController } from "./ArticleComments";
import { createCommentAnchor, getArticleCommentText } from "@/lib/article-comment-text";

const title = "Care guide", bodyMarkdown = "Useful **care advice** for families.";
const text = getArticleCommentText(title, bodyMarkdown);
const anchor = createCommentAnchor(text, text.indexOf("care advice"), text.indexOf("care advice") + 11);
let dom: JSDOM, root: Root, container: HTMLDivElement, controller: ArticleCommentsController;
let serverComments: ArticleComment[];
const fetchMock = vi.fn();
const comment = (): ArticleComment => ({ id: "thread-1", authorName: "Reviewer", articleVersion: 1, anchor, body: "Please clarify this.",
  resolvedAt: null, createdAt: "2026-10-29T10:00:00Z", canResolve: true, replies: [] });

function Harness({ version = 1, body = bodyMarkdown }: { version?: number; body?: string }) {
  controller = useArticleComments({ articleId: "article-1", version, title, bodyMarkdown: body, enabled: true, live: false });
  return createElement(ArticleCommentsPanel, { controller, visible: true, disabled: false, onLocate: () => undefined });
}
async function mount(props = {}) { await act(async () => { root.render(createElement(Harness, props)); }); }
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://test.invalid" });
  vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  // React's input-event fallback uses these in a DOM created after React imports.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  container = dom.window.document.createElement("div"); dom.window.document.body.append(container); root = createRoot(container);
  serverComments = [];
  fetchMock.mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
    if (!options?.method) return Response.json({ comments: structuredClone(serverComments), canComment: true });
    const payload = JSON.parse(String(options.body));
    if (options.method === "PATCH") {
      serverComments[0]!.resolvedAt = payload.resolved ? "2026-10-29T11:00:00Z" : null;
      return Response.json({ id: "thread-1", resolvedAt: serverComments[0]!.resolvedAt });
    }
    if (payload.parentId) {
      const reply = { id: "reply-1", authorName: "Editor", body: payload.body, createdAt: "2026-10-29T11:00:00Z" };
      serverComments[0]!.replies.push(reply); return Response.json({ parentId: payload.parentId, reply });
    }
    const created = { ...comment(), body: payload.body, anchor: payload.anchor, articleVersion: payload.expectedVersion };
    serverComments.push(created); return Response.json({ comment: created });
  });
});
afterEach(async () => { await act(async () => root.unmount()); dom.window.close(); vi.unstubAllGlobals(); });

describe("article comment UI", () => {
  it("posts a selected passage, shows the saved highlight, and only writes the comments endpoint", async () => {
    await mount();
    await act(async () => controller.begin(anchor));
    expect(container.querySelector("blockquote")?.textContent).toBe("care advice");
    await act(async () => controller.setBody("Explain the care plan."));
    await click("Post comment");
    expect(controller.hasDraft).toBe(false); expect(controller.openCount).toBe(1);
    expect(dom.window.document.activeElement?.id).toBe("comment-thread-thread-1");
    expect(controller.highlights).toEqual([{ id: "thread-1", start: anchor.start, end: anchor.end }]);
    expect(container.textContent).toContain("Explain the care plan.");
    const writes = fetchMock.mock.calls.filter(call => call[1]?.method);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("/api/articles/article-1/comments");
    expect(JSON.parse(writes[0]![1].body)).toEqual({ expectedVersion: 1, anchor, body: "Explain the care plan." });
  });
  it("keeps typed comments when saving fails and makes Retry possible without losing the selection", async () => {
    await mount(); await act(async () => controller.begin(anchor)); await act(async () => controller.setBody("Keep this feedback."));
    fetchMock.mockImplementationOnce(async () => Response.json({ error: { message: "Connection lost. Try again." } }, { status: 503 }));
    await click("Post comment");
    expect(controller.body).toBe("Keep this feedback."); expect(controller.draft?.anchor).toEqual(anchor);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    await click("Post comment"); expect(controller.openCount).toBe(1);
  });
  it("shows a posting loader and blocks duplicate submits", async () => {
    await mount(); await act(async () => controller.begin(anchor)); await act(async () => controller.setBody("A review note."));
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await act(async () => { controller.post(); controller.post(); });
    expect(container.textContent).toContain("Posting…");
    expect(fetchMock.mock.calls.filter(call => call[1]?.method)).toHaveLength(1);
    await act(async () => { const created = { ...comment(), body: "A review note." }; serverComments.push(created); finish(Response.json({ comment: created })); });
    expect(controller.busy).toBeNull();
  });
  it("supports replies, resolving, and reopening without changing article content", async () => {
    serverComments = [comment()]; await mount(); await click("Reply");
    await act(async () => controller.setReplyBody("Updated the explanation.")); await click("Post reply");
    expect(container.textContent).toContain("Updated the explanation.");
    await click("Resolve"); expect(controller.openCount).toBe(0);
    await click("Resolved (1)"); await click("Reopen"); expect(controller.openCount).toBe(1);
    expect(fetchMock.mock.calls.every(call => String(call[0]).includes("/comments"))).toBe(true);
  });
  it("retains old discussions when edits remove their selected passage", async () => {
    serverComments = [comment()]; await mount({ version: 2, body: "Completely replaced content." });
    expect(controller.highlights).toEqual([]);
    expect(container.textContent).toContain("Passage changed or removed");
    expect(container.textContent).toContain("Please clarify this.");
  });
  it("does not hide a typed reply if another reviewer resolves its thread", async () => {
    serverComments = [comment()]; await mount(); await click("Reply"); await act(async () => controller.setReplyBody("My unfinished response."));
    serverComments[0]!.resolvedAt = "2026-10-29T11:00:00Z";
    await act(async () => { await controller.refresh(); });
    expect(container.querySelector("textarea")?.value).toBe("My unfinished response.");
    expect(container.textContent).toContain("This discussion was resolved");
    await click("Cancel"); expect(controller.hasDraft).toBe(false);
  });
  it("renders comments as text and keeps repeated passages attached on their original version", async () => {
    const repeated = "a".repeat(64) + "quote" + "b".repeat(64);
    const full = getArticleCommentText(title, repeated + repeated);
    serverComments = [{ ...comment(), anchor: createCommentAnchor(full, title.length + repeated.length + 64, title.length + repeated.length + 69), body: "<script>alert('x')</script>" }];
    await mount({ body: repeated + repeated });
    expect(controller.highlights).toHaveLength(1); expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });
});
