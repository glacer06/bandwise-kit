import { describe, expect, it } from "vitest";
import type { Role, Scope } from "./contracts/common.js";
import { OPERATION_CATALOG, type OperationId, catalogActors } from "./contracts/operations.js";
import type { OrgLessContext, TenantContext } from "./contracts/tenant.js";
import { type AuthzResource, can, minRole, roleAtLeast } from "./authz.js";

const ORG = "01890000-0000-7000-8000-00000000000a";
const OTHER = "01890000-0000-7000-8000-00000000000b";
const SET = "01890000-0000-7000-8000-0000000000a1";
const OTHER_SET = "01890000-0000-7000-8000-0000000000a2";
const USER = "01890000-0000-7000-8000-0000000000c1";

const base = { orgId: ORG, plan: "pro", requestId: "r" } as const;

const user = (role: Role, platformRole: "superadmin" | null = null): TenantContext => ({
  ...base,
  client: "console",
  actor: { type: "user", userId: USER, role, platformRole, impersonatorId: null },
});

const agent = (role: Role, scopes: Scope[], setIds: string[] | null = null): TenantContext => ({
  ...base,
  client: "cli",
  actor: { type: "agent", tokenId: "01890000-0000-7000-8000-0000000000d1", userId: USER, role, scopes, setIds, client: "cli" },
});

const app = (
  scopes: Scope[],
  over: Partial<{ tokenKind: "secret" | "publishable" | "browser"; mode: "live" | "test"; channel: "production" | "staging"; setIds: string[] | null }> = {},
): TenantContext => ({
  ...base,
  client: "api",
  actor: {
    type: "apiKey",
    keyId: "01890000-0000-7000-8000-0000000000e1",
    appId: "01890000-0000-7000-8000-0000000000e2",
    tokenKind: over.tokenKind ?? "secret",
    mode: over.mode ?? "live",
    channel: over.channel ?? "production",
    scopes,
    setIds: over.setIds ?? null,
    origin: null,
  },
});

const system: TenantContext = { ...base, client: "job", actor: { type: "system" } };

const orgLess = (platformRole: "superadmin" | null = null): OrgLessContext => ({
  orgId: null,
  actor: { type: "user", userId: USER, platformRole },
  client: "console",
  requestId: "r",
});

const res = (over: Partial<AuthzResource> = {}): AuthzResource => ({ orgId: ORG, setId: SET, ...over });

type Row = [name: string, ctx: TenantContext | OrgLessContext, op: OperationId, resource: AuthzResource | null, expected: "allow" | "not_found" | "insufficient_scope"];

const rows: Row[] = [
  // Roles against the catalog floor.
  ["viewer runs a set", user("viewer"), "set.run", res(), "allow"],
  ["viewer cannot create a set", user("viewer"), "set.create", res(), "insufficient_scope"],
  ["editor creates a set", user("editor"), "set.create", res(), "allow"],
  ["reviewer resolves review items", user("reviewer"), "review.resolve", res(), "allow"],
  ["viewer cannot resolve review items", user("viewer"), "review.resolve", res(), "insufficient_scope"],
  ["editor cannot read the audit log", user("editor"), "audit.list", res(), "insufficient_scope"],
  ["admin reads the audit log", user("admin"), "audit.list", res(), "allow"],
  ["admin cannot delete the org", user("admin"), "org.delete", res(), "insufficient_scope"],
  ["owner deletes the org", user("owner"), "org.delete", res(), "allow"],

  // Resource raises to admin.
  ["editor publishes an unprotected set", user("editor"), "set.publish", res({ channel: "production" }), "allow"],
  ["editor cannot publish a protected set", user("editor"), "set.publish", res({ channel: "production", protected: true }), "insufficient_scope"],
  ["admin publishes a protected set", user("admin"), "set.publish", res({ channel: "production", protected: true }), "allow"],
  ["editor cannot skip the experiment", user("editor"), "channel.promote", res({ skipExperiment: true }), "insufficient_scope"],
  ["editor moves shadow to controlled", user("editor"), "rollout.change", res({ rolloutFrom: "shadow", rolloutTo: "controlled" }), "allow"],
  ["editor cannot move controlled to full", user("editor"), "rollout.change", res({ rolloutFrom: "controlled", rolloutTo: "full" }), "insufficient_scope"],
  ["admin moves controlled to full", user("admin"), "rollout.change", res({ rolloutFrom: "controlled", rolloutTo: "full" }), "allow"],
  ["editor keeps full at full (no raise)", user("editor"), "rollout.change", res({ rolloutFrom: "full", rolloutTo: "full" }), "allow"],
  ["viewer cannot export standalone code", user("viewer"), "set.codegen", res({ codegenTarget: "standalone" }), "insufficient_scope"],
  ["editor exports standalone code", user("editor"), "set.codegen", res({ codegenTarget: "standalone" }), "allow"],
  ["approval.decide uses the requested operation's role", user("editor"), "approval.decide", res({ requiredRole: "admin" }), "insufficient_scope"],
  ["approval.decide defaults to admin", user("admin"), "approval.decide", res(), "allow"],

  // Cross-org is 404, never 403.
  ["another org's set is not found", user("owner"), "set.get", res({ orgId: OTHER }), "not_found"],
  ["another org's set for an agent is not found", agent("owner", ["sets:read"]), "set.get", res({ orgId: OTHER }), "not_found"],

  // Agent tokens: scope and role both.
  ["agent with sets:read reads a set", agent("viewer", ["sets:read"]), "set.get", res(), "allow"],
  ["agent without the scope", agent("owner", ["run"]), "set.get", res(), "insufficient_scope"],
  ["agent scope without the role", agent("viewer", ["sets:write"]), "set.create", res(), "insufficient_scope"],
  ["agent release scope follows the channel", agent("editor", ["release:staging"]), "set.publish", res({ channel: "production" }), "insufficient_scope"],
  ["agent staging release", agent("editor", ["release:staging"]), "set.publish", res({ channel: "staging" }), "allow"],
  ["agent outside its set allowlist", agent("owner", ["sets:read"], [OTHER_SET]), "set.get", res(), "not_found"],
  ["agent inside its set allowlist", agent("owner", ["sets:read"], [SET]), "set.get", res(), "allow"],
  ["agent cannot confirm (session only)", agent("owner", ["review:write"]), "review.confirm", res(), "insufficient_scope"],
  ["agent any-scope op", agent("viewer", []), "job.get", res(), "allow"],

  // App tokens: scope, channel, mode, publishable run-only.
  ["sk_ runs a set", app(["run"]), "set.run", res({ channel: "production" }), "allow"],
  ["sk_ without run", app(["sets:read"]), "set.run", res(), "insufficient_scope"],
  ["sk_ cannot request another channel", app(["run"]), "set.run", res({ channel: "staging" }), "insufficient_scope"],
  ["sk_live_ cannot run slug@draft", app(["run"]), "set.run", res({ draft: true }), "insufficient_scope"],
  ["sk_test_ runs slug@draft", app(["run"], { mode: "test" }), "set.run", res({ draft: true }), "allow"],
  ["pk_ runs a set", app(["run"], { tokenKind: "publishable" }), "set.run", res(), "allow"],
  ["pk_ cannot read runs", app(["run", "runs:read"], { tokenKind: "publishable" }), "run.list", res(), "insufficient_scope"],
  ["sk_ mints a browser token", app(["run"]), "browser_token.create", res(), "allow"],
  ["a browser token cannot mint another", app(["run"], { tokenKind: "browser" }), "browser_token.create", res(), "insufficient_scope"],
  ["app tokens cannot publish", app(["release:production"]), "set.publish", res(), "insufficient_scope"],
  ["app token outside its allowlist", app(["run"], { setIds: [OTHER_SET] }), "set.run", res(), "not_found"],
  ["app token never gets standalone code", app(["sets:read"]), "set.codegen", res({ codegenTarget: "standalone" }), "insufficient_scope"],
  ["app token reads a manifest", app(["sets:read"]), "set.manifest", res(), "allow"],
  ["app token cannot call codegen", app(["sets:read"]), "set.codegen", res(), "insufficient_scope"],

  // System actor and platform routes.
  ["system demotes", system, "rollout.change", res(), "allow"],
  ["system cannot publish", system, "set.publish", res(), "insufficient_scope"],
  ["superadmin reads platform models", user("viewer", "superadmin"), "platform_model.list", null, "allow"],
  ["org owner gets 404 on platform routes", user("owner"), "platform_model.list", null, "not_found"],
  ["agent gets 404 on platform routes", agent("owner", ["admin:write"]), "platform_settings.update", null, "not_found"],
  ["org-less superadmin", orgLess("superadmin"), "platform_org.list", null, "allow"],
  ["org-less user creates an org", orgLess(), "org.create", null, "allow"],
  ["org-less user cannot list sets", orgLess(), "set.list", null, "not_found"],
  ["a session in an org also creates orgs", user("viewer"), "org.create", null, "allow"],
];

describe("can(): the role and scope matrix", () => {
  it.each(rows)("%s", (_name, ctx, op, resource, expected) => {
    const d = can(ctx, op, resource);
    expect(d.allowed ? "allow" : d.code).toBe(expected);
  });

  it("a missing scope names the scope it needs", () => {
    expect(can(agent("owner", []), "set.publish", res({ channel: "staging" }))).toMatchObject({ requiredScope: "release:staging" });
    expect(can(app(["run"], { tokenKind: "publishable" }), "set.manifest", res())).toMatchObject({ requiredScope: "sets:read" });
  });

  it("a session-only operation says a console session is required", () => {
    const d = can(agent("owner", ["admin:write"]), "portfolio.get", res());
    expect(d.allowed === false && d.reason).toContain("console session");
  });

  it("an owner session may call every row that sessions can call", () => {
    for (const entry of OPERATION_CATALOG.filter((e) => catalogActors(e).includes("user"))) {
      const d = can(user("owner", "superadmin"), entry.id, res({ channel: "production" }));
      expect(d.allowed).toBe(true);
    }
  });

  it("role helpers", () => {
    expect(roleAtLeast("admin", "editor")).toBe(true);
    expect(roleAtLeast("reviewer", "editor")).toBe(false);
    expect(minRole("owner", "editor")).toBe("editor");
    expect(minRole("viewer", "admin")).toBe("viewer");
  });
});
