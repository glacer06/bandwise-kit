
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  API_PREFIX,
  APP_TOKEN_OPERATIONS,
  ApprovalAccepted,
  DryRunResult,
  HIGH_RISK_CONDITIONS,
  Job,
  JobAccepted,
  ListParams,
  NON_OPERATION_ROUTES,
  OPERATION_CATALOG,
  OPERATION_ID_PATTERN,
  OperationCatalogEntry,
  type OperationDef,
  NO_SET_RISK_RESOURCE,
  type OperationContextFor,
  type OrgLessOperationId,
  catalogActors,
  catalogEntry,
  describeOperation,
  runsWithoutOrg,
} from "./operations.js";
import type { OperationContext, TenantContext } from "./tenant.js";

const ids = OPERATION_CATALOG.map((e) => e.id);

describe("OPERATION_CATALOG", () => {
  it("has unique ids", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names every id noun.verb", () => {
    for (const id of ids) expect(id).toMatch(OPERATION_ID_PATTERN);
  });

  it("starts every path with /api/v1", () => {
    for (const e of OPERATION_CATALOG) expect(e.path.startsWith(`${API_PREFIX}/`)).toBe(true);
  });

  it("has unique method and path pairs", () => {
    const routes = OPERATION_CATALOG.map((e) => `${e.method} ${e.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("parses every row with the entry schema", () => {
    for (const e of OPERATION_CATALOG) expect(OperationCatalogEntry.parse(e)).toEqual(e);
  });

  it("marks exactly the read rows read-only", () => {
    for (const e of OPERATION_CATALOG) expect(e.readOnly).toBe(e.risk === "read");
  });

  it("uses only GET for read-only rows, except the validate endpoint", () => {
    const postReads = OPERATION_CATALOG.filter((e) => e.readOnly && e.method !== "GET").map((e) => e.id);
    expect(postReads).toEqual(["draft.validate"]);
  });

  it("keeps platform rows superadmin and session-only", () => {
    for (const e of OPERATION_CATALOG.filter((x) => x.path.startsWith(`${API_PREFIX}/platform/`))) {
      expect(e.scope).toBe("platform_admin");
      expect(e.minRole).toBe("superadmin");
      expect(catalogActors(e)).toEqual(["user"]);
    }
  });

  it("describes a condition for every high* row and only those", () => {
    const conditional = OPERATION_CATALOG.filter((e) => e.risk === "high*").map((e) => e.id).sort();
    expect(Object.keys(HIGH_RISK_CONDITIONS).sort()).toEqual(conditional);
  });

  it("names only catalog operations in the actor lists", () => {
    for (const id of APP_TOKEN_OPERATIONS) expect(ids).toContain(id);
  });

  it("does not list non-operation routes as operations", () => {
    const routes = new Set(OPERATION_CATALOG.map((e) => `${e.method} ${e.path}`));
    for (const r of NON_OPERATION_ROUTES) expect(routes.has(`${r.method} ${r.path}`)).toBe(false);
  });

  it("finds rows by id", () => {
    expect(catalogEntry("set.publish")).toMatchObject({
      method: "POST",
      path: "/api/v1/sets/{ref}/publish",
      scope: "release:<channel>",
      risk: "high*",
    });
  });
});

describe("org-less operations", () => {
  it("are org.create and the platform rows, all session only", () => {
    const orgLess = OPERATION_CATALOG.filter(runsWithoutOrg).map((e) => e.id);
    expect(orgLess).toContain("org.create");
    expect(orgLess.filter((id) => id !== "org.create").every((id) => id.startsWith("platform_"))).toBe(true);
    expect(orgLess).not.toContain("browser_token.create");
    for (const id of orgLess) expect(catalogActors(catalogEntry(id))).toEqual(["user"]);
  });

  it("type their handler context as OperationContext, every other operation as TenantContext", () => {
    expectTypeOf<"org.create">().toExtend<OrgLessOperationId>();
    expectTypeOf<OperationContextFor<"org.create">>().toEqualTypeOf<OperationContext>();
    expectTypeOf<OperationContextFor<"platform_org.suspend">>().toEqualTypeOf<OperationContext>();
    expectTypeOf<OperationContextFor<"set.publish">>().toEqualTypeOf<TenantContext>();
    expectTypeOf<OperationContextFor<"browser_token.create">>().toEqualTypeOf<TenantContext>();
  });

  it("have a RiskResource with no set", () => {
    expect(NO_SET_RISK_RESOURCE).toEqual({ protected: false, stages: { production: null, staging: null }, storageMode: null });
  });
});

describe("catalogActors", () => {
  it("applies the documented actor rules", () => {
    expect(catalogActors(catalogEntry("approval.decide"))).toEqual(["user"]);
    expect(catalogActors(catalogEntry("review.confirm"))).toEqual(["user"]);
    expect(catalogActors(catalogEntry("org.create"))).toEqual(["user"]);
    expect(catalogActors(catalogEntry("browser_token.create"))).toEqual(["apiKey"]);
    expect(catalogActors(catalogEntry("set.run"))).toEqual(["user", "agent", "apiKey"]);
    expect(catalogActors(catalogEntry("rollout.change"))).toEqual(["user", "agent", "system"]);
    expect(catalogActors(catalogEntry("set.publish"))).toEqual(["user", "agent"]);
  });
});

describe("describeOperation", () => {
  const ctx = {} as TenantContext;
  const Input = z.object({ channel: z.enum(["production", "staging"]), changelog: z.string() });
  const publish: OperationDef<z.infer<typeof Input>, { version: number }> = {
    id: "set.publish",
    summary: "Publish the draft to a channel.",
    input: Input,
    output: z.object({ version: z.number() }),
    scope: (input) => (input.channel === "production" ? "release:production" : "release:staging"),
    minRole: "editor",
    actors: ["user", "agent"],
    risk: (_ctx, input, resource) =>
      input.channel === "production" && (resource.protected || resource.stages.production === "full") ? "high" : "normal",
    towardSafety: false,
    readOnly: false,
    destructive: false,
    async: false,
    http: { method: "POST", path: "/api/v1/sets/{ref}/publish" },
    mcp: { tool: "publish_set" },
    emits: ["set.published", "interface.breaking_published"],
    preview: () => Promise.reject(new Error("not used")),
    handler: () => Promise.resolve({ version: 8 }),
  };

  it("turns function fields into data", () => {
    expect(describeOperation(publish)).toEqual({
      id: "set.publish",
      summary: "Publish the draft to a channel.",
      scope: "release:<channel>",
      minRole: "editor",
      actors: ["user", "agent"],
      risk: "high*",
      towardSafety: false,
      readOnly: false,
      destructive: false,
      async: false,
      http: { method: "POST", path: "/api/v1/sets/{ref}/publish" },
      mcp: { tool: "publish_set" },
      emits: ["set.published", "interface.breaking_published"],
      dryRun: true,
    });
  });

  it("keeps plain fields and omits mcp when absent", async () => {
    const { mcp: _omit, preview: _p, ...rest } = publish;
    const d = describeOperation({ ...rest, scope: "sets:write", risk: "normal" });
    expect(d.scope).toBe("sets:write");
    expect(d.risk).toBe("normal");
    expect(d.dryRun).toBe(false);
    expect(d).not.toHaveProperty("mcp");
    await expect(publish.handler(ctx, { channel: "staging", changelog: "x" })).resolves.toEqual({ version: 8 });
  });
});

describe("DryRunResult", () => {
  const dry = {
    diff: { from: "triage@3", to: "triage@draft", changes: [], interface: { breaking: [], additive: [] } },
    lints: [{ path: "/model", rule: "model.alias_past_shadow", severity: "error", message: "pin a model" }],
    gates: [{ id: "shadow_runs", required: 200, actual: 120, met: false }],
    approvalRequired: true,
    interfaceChange: { breaking: ["choice option removed: category.newsletter"], additive: [], majorFrom: 1, majorTo: 2 },
  };

  it("parses the documented shape and round-trips", () => {
    expect(DryRunResult.parse(dry)).toEqual(dry);
    expect(DryRunResult.parse(JSON.parse(JSON.stringify(dry)))).toEqual(dry);
  });

  it("allows a null interfaceChange and requires approvalRequired", () => {
    expect(DryRunResult.safeParse({ ...dry, interfaceChange: null }).success).toBe(true);
    const { approvalRequired: _omit, ...rest } = dry;
    expect(DryRunResult.safeParse(rest).success).toBe(false);
  });
});

describe("jobs, approvals and lists", () => {
  const jobId = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f60";

  it("parses 202 bodies", () => {
    expect(JobAccepted.parse({ jobId })).toEqual({ jobId });
    const approval = {
      approval: {
        id: "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f61",
        status: "pending",
        url: "https://console.example.com/approvals/0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f61",
        expiresAt: "2026-10-03T12:00:00Z",
      },
    };
    expect(ApprovalAccepted.parse(approval)).toEqual(approval);
    expect(
      ApprovalAccepted.safeParse({ approval: { ...approval.approval, status: "approved" } }).success,
    ).toBe(false);
  });

  it("parses a job and rejects an unknown kind", () => {
    const job = { id: jobId, kind: "eval", status: "running", createdAt: "2026-09-26T10:00:00Z" };
    expect(Job.parse(job)).toEqual(job);
    expect(Job.safeParse({ ...job, kind: "deploy" }).success).toBe(false);
  });

  it("defaults and bounds list params", () => {
    expect(ListParams.parse({})).toEqual({ limit: 50 });
    expect(ListParams.parse({ limit: "200", cursor: "abc" })).toEqual({ limit: 200, cursor: "abc" });
    expect(ListParams.safeParse({ limit: 201 }).success).toBe(false);
    expect(ListParams.safeParse({ limit: 0 }).success).toBe(false);
  });
});
