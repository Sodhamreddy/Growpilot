import { describe, expect, it } from "vitest";
import { integrationState, readIntegrationState } from "./integration-state";
import type { TenantContext } from "@ob/core";

const ctx: TenantContext = { userId: "user", workspaceId: "workspace", role: "admin", correlationId: "test" };
const client = "11111111-1111-4111-8111-111111111111";
describe("OAuth consent binding", () => {
  it("retains the originating client independently of subsequent client selection", () => {
    const state = integrationState(ctx, client);
    expect(readIntegrationState(state, state, ctx)).toEqual({ businessId: client });
  });
  it("rejects changed state, workspace or user", () => {
    const state = integrationState(ctx, client);
    expect(readIntegrationState(state, `${state}other`, ctx)).toBeNull();
    expect(readIntegrationState(state, state, { ...ctx, workspaceId: "other" })).toBeNull();
    expect(readIntegrationState(state, state, { ...ctx, userId: "other" })).toBeNull();
    expect(readIntegrationState(undefined, state, ctx)).toBeNull();
  });
  it("does not select a later client when consent began without one", () => {
    const state = integrationState(ctx, null);
    expect(readIntegrationState(state, state, ctx)).toEqual({ businessId: null });
  });
  it("rejects legacy incomplete bindings and malformed client ids", () => {
    expect(readIntegrationState("nonce.workspace", "nonce.workspace", ctx)).toBeNull();
    expect(readIntegrationState("nonce.workspace.user.invalid", "nonce.workspace.user.invalid", ctx)).toBeNull();
  });
});
