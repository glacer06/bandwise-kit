import { describe, expect, it } from "vitest";

import { AppTokenPrefix, OperationContext, OrgLessContext, PublishCtx, TenantContext } from "./tenant.js";

const ORG = "01923f40-0000-7aaa-9bbb-000000000001";
const USER = "01923f40-0000-7aaa-9bbb-0000000000a1";
const TOKEN = "01923f40-0000-7aaa-9bbb-0000000000b1";
const APP = "01923f40-0000-7aaa-9bbb-0000000000c1";
const KEY = "01923f40-0000-7aaa-9bbb-0000000000d1";
const SET = "01923f40-0000-7aaa-9bbb-0000000000e1";

const base = { orgId: ORG, plan: "team", requestId: "req_1" };

describe("TenantContext", () => {
  it("accepts a console user", () => {
    const ctx = {
      ...base,
      client: "console",
      actor: { type: "user", userId: USER, role: "editor", platformRole: null, impersonatorId: null },
    };
    expect(TenantContext.parse(ctx)).toEqual(ctx);
  });

  it("accepts an impersonating superadmin", () => {
    const ctx = {
      ...base,
      client: "console",
      actor: { type: "user", userId: USER, role: "viewer", platformRole: "superadmin", impersonatorId: USER },
    };
    expect(TenantContext.safeParse(ctx).success).toBe(true);
  });

  it("accepts an app token, a publishable token and a browser token", () => {
    const apiKey = {
      type: "apiKey",
      keyId: KEY,
      appId: APP,
      tokenKind: "secret",
      mode: "live",
      channel: "production",
      scopes: ["run", "feedback:write"],
      setIds: null,
      origin: null,
    };
    expect(TenantContext.safeParse({ ...base, client: "api", actor: apiKey }).success).toBe(true);
    const browser = { ...apiKey, tokenKind: "browser", scopes: ["run"], setIds: [SET], origin: "https://app.example.com" };
    expect(TenantContext.safeParse({ ...base, client: "api", actor: browser }).success).toBe(true);
    expect(TenantContext.safeParse({ ...base, client: "api", actor: { ...apiKey, channel: "draft" } }).success).toBe(false);
  });

  it("accepts an agent token with its client", () => {
    const agent = { type: "agent", tokenId: TOKEN, userId: USER, role: "editor", scopes: ["sets:write"], setIds: null, client: "mcp" };
    expect(TenantContext.safeParse({ ...base, client: "mcp", actor: agent }).success).toBe(true);
    expect(TenantContext.safeParse({ ...base, client: "mcp", actor: { ...agent, client: "job" } }).success).toBe(false);
  });

  it("accepts the system actor", () => {
    expect(TenantContext.safeParse({ ...base, client: "job", actor: { type: "system" } }).success).toBe(true);
  });

  it("is strict: unknown keys fail on the context and on the actor", () => {
    const ctx = { ...base, client: "job", actor: { type: "system" } };
    expect(TenantContext.safeParse({ ...ctx, extra: 1 }).success).toBe(false);
    expect(TenantContext.safeParse({ ...ctx, actor: { type: "system", userId: USER } }).success).toBe(false);
  });

  it("rejects unknown actor types, roles and scopes", () => {
    const user = { type: "user", userId: USER, role: "editor", platformRole: null, impersonatorId: null };
    expect(TenantContext.safeParse({ ...base, client: "console", actor: { ...user, type: "robot" } }).success).toBe(false);
    expect(TenantContext.safeParse({ ...base, client: "console", actor: { ...user, role: "god" } }).success).toBe(false);
    const agent = { type: "agent", tokenId: TOKEN, userId: USER, role: "editor", scopes: ["sets:delete"], setIds: null, client: "cli" };
    expect(TenantContext.safeParse({ ...base, client: "cli", actor: agent }).success).toBe(false);
  });
});

describe("OrgLessContext", () => {
  const orgLess = {
    orgId: null,
    actor: { type: "user", userId: USER, platformRole: null },
    client: "console",
    requestId: "req_2",
  };

  it("lets a signed-in user with no membership act, with no role and no plan", () => {
    expect(OrgLessContext.parse(orgLess)).toEqual(orgLess);
    expect(OrgLessContext.safeParse({ ...orgLess, actor: { ...orgLess.actor, platformRole: "superadmin" } }).success).toBe(true);
  });

  it("is session only and never carries an org", () => {
    expect(OrgLessContext.safeParse({ ...orgLess, orgId: ORG }).success).toBe(false);
    expect(OrgLessContext.safeParse({ ...orgLess, client: "mcp" }).success).toBe(false);
    const agent = { type: "agent", tokenId: TOKEN, userId: USER, role: "editor", scopes: [], setIds: null, client: "cli" };
    expect(OrgLessContext.safeParse({ ...orgLess, actor: agent }).success).toBe(false);
    expect(OrgLessContext.safeParse({ ...orgLess, actor: { ...orgLess.actor, role: "owner" } }).success).toBe(false);
  });

  it("OperationContext accepts either kind", () => {
    const tenant = {
      ...base,
      client: "console",
      actor: { type: "user", userId: USER, role: "editor", platformRole: null, impersonatorId: null },
    };
    expect(OperationContext.safeParse(orgLess).success).toBe(true);
    expect(OperationContext.safeParse(tenant).success).toBe(true);
    expect(OperationContext.safeParse({ ...tenant, orgId: null }).success).toBe(false);
  });
});

describe("AppTokenPrefix", () => {
  it("lists the app token prefixes", () => {
    expect(AppTokenPrefix.options).toEqual(["sk_live_", "sk_test_", "pk_live_"]);
  });
});

describe("PublishCtx", () => {
  const iface = {
    inputSchema: { type: "object" },
    questions: [{ id: "category", type: "choice", options: ["a", "none_of_these"] }],
    composites: [],
    routeOutputs: ["normal"],
  };
  const ctx = {
    channel: "production",
    rolloutStage: "inactive",
    served: [{ channel: "production", interface: iface, interfaceMajor: 1, hasConsumers: false }],
    newMajor: 1,
    systemOneProvider: "typesafe",
    reachableModels: ["jev-1.13.0", "jev-latest"],
    modelRoutes: [],
    pricedModels: ["jev-1.13.0", "claude-haiku-4-5"],
    allowPreviewModels: false,
    enabledHandlers: ["builtin.slack.notify"],
    fallbackSets: { "email-triage-v1": { usesSetFallback: false } },
    hashOnly: false,
  };

  it("parses a publish context", () => {
    expect(PublishCtx.safeParse(ctx).success).toBe(true);
  });

  it("needs the priced models for escalation.model_unpriced", () => {
    const { pricedModels: _omit, ...rest } = ctx;
    expect(PublishCtx.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-pointer target channel and unknown keys", () => {
    expect(PublishCtx.safeParse({ ...ctx, channel: "pinned" }).success).toBe(false);
    expect(PublishCtx.safeParse({ ...ctx, rollout: "full" }).success).toBe(false);
  });
});
