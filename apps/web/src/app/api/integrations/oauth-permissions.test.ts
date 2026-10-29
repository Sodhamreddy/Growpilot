import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ role: "viewer", cookies: vi.fn(), database: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireTenant: async () => ({ role: state.role, userId: "user", workspaceId: "workspace" }) }));
vi.mock("next/headers", () => ({ cookies: state.cookies }));
vi.mock("@/lib/services", () => ({ db: state.database, getQueues: vi.fn() }));
import { GET as googleStart } from "./google-business/start/route";
import { GET as googleCallback } from "./google-business/callback/route";
import { GET as metaStart } from "./meta/start/route";
import { GET as metaCallback } from "./meta/callback/route";

beforeEach(() => vi.clearAllMocks());
it.each(["viewer", "editor"])("blocks %s before reading or changing OAuth state", async role => {
  state.role = role;
  const req = new Request("http://localhost/callback?state=state&code=code");
  for (const handler of [googleStart, googleCallback, metaStart, metaCallback]) {
    const response = await handler(req);
    expect(response.status).toBe(403);
  }
  expect(state.cookies).not.toHaveBeenCalled();
  expect(state.database).not.toHaveBeenCalled();
});
