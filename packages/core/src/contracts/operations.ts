// OperationDef, OperationDescriptor, DryRunResult, the job and approval bodies, and
// OPERATION_CATALOG, a machine-readable copy of every row of the documented catalog.
// The registry itself lives in apps/console/src/server/operations.

import { z } from "zod";

import {
  ApprovalId,
  IsoTimestamp,
  JobId,
  JsonValue,
  Role,
  type RolloutStage,
  Scope,
  type StorageMode,
} from "./common.js";
import { ErrorDetail, GateResult } from "./errors.js";
import { JobError, JobKind, JobStatus, type EventType } from "./events.js";
import { SpecDiff } from "./spec-diff.js";
import type { ActorKind, OperationContext, TenantContext } from "./tenant.js";

// ---------------------------------------------------------------------------
// Primitives

/** `noun.verb`, identical to the audit action the operation writes. */
export const OPERATION_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export const OperationIdString = z.string().regex(OPERATION_ID_PATTERN);

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** Who may call an operation. `["user"]` means session only. */
export const OperationActor = z.enum(["user", "agent", "apiKey", "system"]);
export type OperationActor = z.infer<typeof OperationActor>;

/** The actors an operation allows when it does not say otherwise. */
export const DEFAULT_OPERATION_ACTORS = ["user", "agent"] as const satisfies readonly OperationActor[];

/**
 * The floor role. "superadmin" is users.platform_role (platform operations). "none" is for
 * operations that run without an org membership: `org.create`, and `browser_token.create`, which
 * only app tokens call and app tokens have no role.
 */
export const OperationMinRole = z.union([Role, z.literal("superadmin"), z.literal("none")]);
export type OperationMinRole = z.infer<typeof OperationMinRole>;

/** Each pointer channel's current rollout stage. Null when that channel has no pointer yet. */
export interface ChannelStages {
  production: RolloutStage | null;
  staging: RolloutStage | null;
}

/** What the approval gate needs to decide a conditional risk. Operations without a set pass the defaults. */
export interface RiskResource {
  /** question_sets.protected; false when the operation has no set. */
  protected: boolean;
  /** The set's pointers; both null when the operation has no set. */
  stages: ChannelStages;
  /** question_sets.storage_mode, for set.update; null when the operation has no set. */
  storageMode: StorageMode | null;
}

/** The RiskResource for an operation that touches no set. */
export const NO_SET_RISK_RESOURCE: RiskResource = Object.freeze({
  protected: false,
  stages: Object.freeze({ production: null, staging: null }),
  storageMode: null,
});

export interface OperationHttp {
  method: HttpMethod;
  /** Full path, for example "/api/v1/sets/{ref}/publish". */
  path: string;
}

// ---------------------------------------------------------------------------
// DryRunResult

export const InterfaceChange = z.object({
  breaking: z.array(z.string()),
  additive: z.array(z.string()),
  majorFrom: z.number().int().nonnegative(),
  majorTo: z.number().int().nonnegative(),
});
export type InterfaceChange = z.infer<typeof InterfaceChange>;

/** What `?dryRun=true` returns on publish, rollback, promote, rollout change and try-model. */
export const DryRunResult = z.object({
  /** Same shape as GET /sets/{ref}/diff. */
  diff: SpecDiff,
  /** Same shape as error.details. */
  lints: z.array(ErrorDetail),
  /** Same shape as error.gates. */
  gates: z.array(GateResult),
  /** Would this call return 202 with an approval. */
  approvalRequired: z.boolean(),
  interfaceChange: InterfaceChange.nullable(),
});
export type DryRunResult = z.infer<typeof DryRunResult>;

// ---------------------------------------------------------------------------
// OperationDef

/**
 * One management capability. Registered once, behind the console, the API, the CLI and MCP.
 * `C` is the context the handler receives: TenantContext, or OperationContext for the operations
 * in ORG_LESS_OPERATIONS.
 */
export interface OperationDef<I, O, C extends OperationContext = TenantContext> {
  id: string;
  /** One line: the OpenAPI summary, CLI help and MCP tool description. */
  summary: string;
  /** Path params, query and body merged into one object. */
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** A function when the channel decides (release:staging or release:production). "any": any authenticated actor in the org. */
  scope: Scope | "any" | ((input: I) => Scope);
  /** The floor; can() raises it for protected sets, entering full and skipExperiment. */
  minRole: OperationMinRole;
  /** Defaults to ["user", "agent"]. ["user"] means session only. */
  actors: OperationActor[];
  /** A function for the conditional high* rows of the catalog. */
  risk: "normal" | "high" | ((ctx: C, input: I, resource: RiskResource) => "normal" | "high");
  /** Only ever makes things safer (pause, rollback, demote, stop, revoke): never gated. */
  towardSafety: boolean;
  readOnly: boolean;
  destructive: boolean;
  /** True: returns 202 { jobId }. */
  async: boolean;
  http: OperationHttp;
  /** Only for curated MCP tools. */
  mcp?: { tool: string };
  /** Events it writes; [] for read-only operations. */
  emits: EventType[];
  /** Only on operations that accept ?dryRun=true. */
  preview?: (ctx: C, input: I) => Promise<DryRunResult>;
  handler: (ctx: C, input: I) => Promise<O>;
}

/** A scope as a descriptor or the catalog records it. A channel-dependent scope becomes "release:<channel>". */
export type DescriptorScope = Scope | "any" | "release:<channel>";

/** A risk as data. "high*" means high only under the conditions in HIGH_RISK_CONDITIONS. */
export type DescriptorRisk = "normal" | "high" | "high*";

/**
 * An OperationDef without zod schemas or functions: plain data for OpenAPI extensions, CLI help,
 * MCP annotations and the parity test.
 */
export interface OperationDescriptor {
  id: string;
  summary: string;
  scope: DescriptorScope;
  minRole: OperationMinRole;
  actors: OperationActor[];
  risk: DescriptorRisk;
  towardSafety: boolean;
  readOnly: boolean;
  destructive: boolean;
  async: boolean;
  http: OperationHttp;
  mcp?: { tool: string };
  emits: EventType[];
  /** True when the operation has a preview, so it accepts ?dryRun=true. */
  dryRun: boolean;
}

export function describeOperation<I, O, C extends OperationContext>(op: OperationDef<I, O, C>): OperationDescriptor {
  const d: OperationDescriptor = {
    id: op.id,
    summary: op.summary,
    scope: typeof op.scope === "function" ? "release:<channel>" : op.scope,
    minRole: op.minRole,
    actors: [...op.actors],
    risk: typeof op.risk === "function" ? "high*" : op.risk,
    towardSafety: op.towardSafety,
    readOnly: op.readOnly,
    destructive: op.destructive,
    async: op.async,
    http: { ...op.http },
    emits: [...op.emits],
    dryRun: op.preview !== undefined,
  };
  if (op.mcp !== undefined) d.mcp = { ...op.mcp };
  return d;
}

// ---------------------------------------------------------------------------
// Route conventions, jobs and approvals

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

/** `limit` and `cursor` for every list operation. Query strings arrive as text, so limit is coerced. */
export const ListParams = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});
export type ListParams = z.infer<typeof ListParams>;

/** `202 { jobId }`. Evals also return evalRunId. */
export const JobAccepted = z.object({
  jobId: JobId,
  evalRunId: z.uuid().optional(),
});
export type JobAccepted = z.infer<typeof JobAccepted>;

/** The body of GET /api/v1/jobs/{id} (job.get). */
export const Job = z.object({
  id: JobId,
  kind: JobKind,
  status: JobStatus,
  result: JsonValue.optional(),
  error: JobError.optional(),
  createdAt: IsoTimestamp,
  finishedAt: IsoTimestamp.optional(),
});
export type Job = z.infer<typeof Job>;

/** `202 { approval }`: an agent called a high-risk operation. Approval is not an error. */
export const ApprovalAccepted = z.object({
  approval: z.object({
    id: ApprovalId,
    status: z.literal("pending"),
    /** The console page where a person decides. */
    url: z.url(),
    expiresAt: IsoTimestamp,
  }),
});
export type ApprovalAccepted = z.infer<typeof ApprovalAccepted>;

// ---------------------------------------------------------------------------
// Catalog: every row, in table order

export const API_PREFIX = "/api/v1";

/** A roadmap phase as the catalog's Phase column names it. */
export const Phase = z.enum(["0", "1", "2", "3", "3b", "4", "4b", "5", "6", "7"]);
export type Phase = z.infer<typeof Phase>;

/**
 * The catalog's Scope column. "session_only" rows have actors ["user"]; "platform_admin" rows
 * need a superadmin console session with MFA.
 */
export const CatalogScope = z.union([
  Scope,
  z.literal("release:<channel>"),
  z.literal("any"),
  z.literal("session_only"),
  z.literal("platform_admin"),
]);
export type CatalogScope = z.infer<typeof CatalogScope>;

/**
 * The catalog's Min role column. "requested_operation": approval.decide needs the role of the
 * operation being approved. portfolio.get records "admin", checked per org.
 */
export const CatalogMinRole = z.union([OperationMinRole, z.literal("requested_operation")]);
export type CatalogMinRole = z.infer<typeof CatalogMinRole>;

/** The catalog's Risk column: read-only, never gated, gated, gated on conditions, toward safety. */
export const CatalogRisk = z.enum(["read", "normal", "high", "high*", "safety"]);
export type CatalogRisk = z.infer<typeof CatalogRisk>;

export const OperationCatalogEntry = z.strictObject({
  id: OperationIdString,
  method: HttpMethod,
  path: z.string().startsWith(`${API_PREFIX}/`),
  phase: Phase,
  scope: CatalogScope,
  minRole: CatalogMinRole,
  risk: CatalogRisk,
  readOnly: z.boolean(),
});
export type OperationCatalogEntry = z.infer<typeof OperationCatalogEntry>;

type Row = readonly [HttpMethod, string, string, CatalogScope, CatalogMinRole, CatalogRisk, Phase];

function rows<const T extends readonly Row[]>(table: T) {
  return table.map(([method, path, id, scope, minRole, risk, phase]) => ({
    id,
    method,
    path: `${API_PREFIX}${path}`,
    phase,
    scope,
    minRole,
    risk,
    readOnly: risk === "read",
  })) as { [K in keyof T]: CatalogEntryOf<T[K]> };
}

type CatalogEntryOf<R> = R extends readonly [
  infer M extends HttpMethod,
  infer P extends string,
  infer Id extends string,
  infer S extends CatalogScope,
  infer MR extends CatalogMinRole,
  infer Rk extends CatalogRisk,
  infer Ph extends Phase,
]
  ? {
      id: Id;
      method: M;
      path: `${typeof API_PREFIX}${P}`;
      phase: Ph;
      scope: S;
      minRole: MR;
      risk: Rk;
      readOnly: Rk extends "read" ? true : false;
    }
  : never;

export const OPERATION_CATALOG = rows([
  // Runs and usage
  ["POST", "/sets/{ref}/run", "set.run", "run", "viewer", "normal", "2"],
  ["GET", "/sets/{ref}/manifest", "set.manifest", "sets:read", "viewer", "read", "3"],
  ["GET", "/runs", "run.list", "runs:read", "viewer", "read", "3"],
  ["GET", "/runs/{id}", "run.get", "runs:read", "viewer", "read", "3"],
  ["GET", "/usage", "usage.get", "usage:read", "viewer", "read", "3"],
  ["POST", "/tokens/browser", "browser_token.create", "run", "none", "normal", "2"],
  ["POST", "/runs/ingest", "run.ingest", "runs:write", "viewer", "normal", "4b"],

  // Projects and goals
  ["GET", "/projects", "project.list", "sets:read", "viewer", "read", "3"],
  ["POST", "/projects", "project.create", "sets:write", "editor", "normal", "3"],
  ["GET", "/goals", "goal.list", "sets:read", "viewer", "read", "3"],
  ["POST", "/goals", "goal.create", "sets:write", "editor", "normal", "3"],
  ["PATCH", "/goals/{id}", "goal.update", "sets:write", "editor", "normal", "3"],

  // Sets and drafts
  ["GET", "/templates", "template.list", "sets:read", "viewer", "read", "3"],
  ["GET", "/sets", "set.list", "sets:read", "viewer", "read", "3"],
  ["POST", "/sets", "set.create", "sets:write", "editor", "normal", "3"],
  ["GET", "/sets/{ref}", "set.get", "sets:read", "viewer", "read", "3"],
  // high*, not the table's normal: a storageMode move to a less private mode is a
  // PII change, high risk for agents.
  ["PATCH", "/sets/{ref}", "set.update", "sets:write", "editor", "high*", "3"],
  ["POST", "/sets/{ref}/archive", "set.archive", "sets:write", "editor", "normal", "3"],
  ["GET", "/sets/{ref}/draft", "draft.get", "sets:read", "viewer", "read", "3"],
  ["PUT", "/sets/{ref}/draft", "draft.update", "sets:write", "editor", "normal", "3"],
  ["POST", "/sets/{ref}/draft/validate", "draft.validate", "sets:read", "viewer", "read", "3"],

  // Versions and releases
  ["GET", "/sets/{ref}/versions", "version.list", "sets:read", "viewer", "read", "3"],
  ["GET", "/sets/{ref}/versions/{n}", "version.get", "sets:read", "viewer", "read", "3"],
  ["GET", "/sets/{ref}/diff", "version.diff", "sets:read", "viewer", "read", "3"],
  ["POST", "/sets/{ref}/publish", "set.publish", "release:<channel>", "editor", "high*", "3"],
  ["POST", "/sets/{ref}/channels/{channel}/rollback", "channel.rollback", "release:<channel>", "editor", "safety", "3"],
  ["POST", "/sets/{ref}/channels/{channel}/promote", "channel.promote", "release:production", "editor", "high*", "3"],
  ["GET", "/sets/{ref}/releases", "release.list", "sets:read", "viewer", "read", "3"],

  // Rollout
  ["GET", "/sets/{ref}/channels/{channel}/rollout", "rollout.get", "sets:read", "viewer", "read", "3"],
  ["PUT", "/sets/{ref}/channels/{channel}/rollout", "rollout.change", "release:<channel>", "editor", "high*", "3"],

  // Experiments (Phase 3b)
  // high*, not the table's normal: samplePct above 0.25 is high
  // risk for agents.
  ["POST", "/sets/{ref}/experiments", "experiment.start", "release:<channel>", "editor", "high*", "3b"],
  ["GET", "/experiments/{id}", "experiment.get", "sets:read", "viewer", "read", "3b"],
  ["POST", "/experiments/{id}/promote", "experiment.promote", "release:<channel>", "editor", "high", "3b"],
  ["POST", "/experiments/{id}/stop", "experiment.stop", "release:<channel>", "editor", "safety", "3b"],

  // Datasets, evals and jobs
  ["GET", "/datasets", "dataset.list", "sets:read", "viewer", "read", "3"],
  ["POST", "/datasets", "dataset.create", "sets:write", "editor", "normal", "3"],
  ["POST", "/datasets/{id}/cases", "dataset.import", "sets:write", "editor", "normal", "3"],
  ["GET", "/datasets/{id}/cases", "dataset.cases", "sets:read", "viewer", "read", "3"],
  ["POST", "/datasets/{id}/snapshots", "dataset.snapshot", "sets:write", "editor", "normal", "3"],
  ["GET", "/datasets/{id}/export", "dataset.export", "sets:read", "editor", "read", "3"],
  ["GET", "/datasets/{id}/features", "dataset.features", "sets:read", "editor", "read", "3b"],
  ["POST", "/evals", "eval.run", "evals:run", "editor", "normal", "3"],
  ["GET", "/evals/{id}", "eval.get", "sets:read", "viewer", "read", "3"],
  ["POST", "/sets/{ref}/compare", "set.compare", "evals:run", "editor", "normal", "3"],
  ["GET", "/jobs/{id}", "job.get", "any", "viewer", "read", "3"],

  // Review and feedback
  ["GET", "/review", "review.list", "review:read", "reviewer", "read", "3"],
  ["POST", "/review/{id}/assign", "review.assign", "review:write", "reviewer", "normal", "3"],
  ["POST", "/review/{id}/resolve", "review.resolve", "review:write", "reviewer", "normal", "3"],
  ["POST", "/review/{id}/dismiss", "review.dismiss", "review:write", "reviewer", "normal", "3"],
  ["POST", "/review/{id}/confirm", "review.confirm", "session_only", "reviewer", "normal", "3"],
  ["POST", "/feedback", "feedback.report", "feedback:write", "reviewer", "normal", "3"],

  // Health, tuning and proposals (Phase 3b)
  ["GET", "/sets/{ref}/health", "health.get", "reports:read", "viewer", "read", "3b"],
  ["GET", "/health", "health.list", "reports:read", "viewer", "read", "3b"],
  ["POST", "/sets/{ref}/policy-suggestions", "policy.suggest", "sets:read", "editor", "normal", "3b"],
  ["GET", "/proposals", "proposal.list", "sets:read", "viewer", "read", "3b"],
  ["POST", "/proposals/{id}/accept", "proposal.accept", "sets:write", "editor", "normal", "3b"],
  ["POST", "/proposals/{id}/reject", "proposal.reject", "sets:write", "editor", "normal", "3b"],

  // Definition Studio
  ["GET", "/studio/sessions", "studio.list", "sets:read", "viewer", "read", "3"],
  ["POST", "/studio/sessions", "studio.create", "sets:write", "editor", "normal", "3"],
  ["GET", "/studio/sessions/{id}", "studio.get", "sets:read", "viewer", "read", "3"],
  ["POST", "/studio/sessions/{id}/examples", "studio.add_examples", "sets:write", "editor", "normal", "3"],
  ["POST", "/studio/sessions/{id}/draft-definition", "studio.draft_definition", "sets:write", "editor", "normal", "3"],
  ["POST", "/studio/sessions/{id}/decompose", "studio.decompose", "sets:write", "editor", "normal", "3"],
  ["POST", "/studio/sessions/{id}/calibrate", "studio.calibrate", "evals:run", "editor", "normal", "3"],
  ["POST", "/studio/sessions/{id}/request-labels", "studio.request_labels", "sets:write", "editor", "normal", "3"],
  ["POST", "/studio/sessions/{id}/promote", "studio.promote", "sets:write", "editor", "normal", "3"],
  ["POST", "/sets/{ref}/improve", "set.improve", "evals:run", "editor", "normal", "3b"],

  // Models
  ["GET", "/models", "model.list", "sets:read", "viewer", "read", "3"],
  ["GET", "/models/{id}", "model.get", "sets:read", "viewer", "read", "3"],
  ["GET", "/model-upgrades", "model.upgrades", "sets:read", "viewer", "read", "3b"],
  ["POST", "/sets/{ref}/try-model", "set.try_model", "evals:run", "editor", "normal", "3b"],

  // Apps and integration
  ["GET", "/apps", "app.list", "sets:read", "viewer", "read", "2"],
  ["POST", "/apps", "app.create", "apps:write", "admin", "normal", "2"],
  ["PATCH", "/apps/{id}", "app.update", "apps:write", "admin", "normal", "2"],
  ["POST", "/apps/{id}/tokens", "app_token.create", "apps:write", "admin", "high*", "2"],
  ["DELETE", "/apps/{id}/tokens/{tokenId}", "app_token.revoke", "apps:write", "admin", "safety", "2"],
  ["GET", "/apps/{id}/opportunities", "opportunity.list", "sets:read", "viewer", "read", "4b"],
  ["POST", "/apps/{id}/opportunities", "opportunity.create", "apps:write", "editor", "normal", "4b"],
  ["PATCH", "/apps/{id}/opportunities/{oid}", "opportunity.update", "apps:write", "editor", "normal", "4b"],
  ["GET", "/apps/{id}/bindings", "binding.list", "sets:read", "viewer", "read", "4b"],
  ["POST", "/apps/{id}/bindings", "binding.create", "apps:write", "editor", "normal", "4b"],
  ["DELETE", "/apps/{id}/bindings/{bid}", "binding.remove", "apps:write", "editor", "normal", "4b"],
  ["GET", "/sets/{ref}/codegen", "set.codegen", "sets:read", "viewer", "read", "4b"],

  // Reports, audit and events
  ["GET", "/reports/{name}", "report.get", "reports:read", "viewer", "read", "3"],
  ["GET", "/alerts", "alert.list", "reports:read", "viewer", "read", "3"],
  ["GET", "/audit", "audit.list", "audit:read", "admin", "read", "3"],
  ["GET", "/events", "event.list", "events:read", "viewer", "read", "3"],
  ["GET", "/webhooks", "webhook.list", "admin:write", "admin", "read", "5"],
  ["POST", "/webhooks", "webhook.create", "admin:write", "admin", "normal", "5"],
  ["DELETE", "/webhooks/{id}", "webhook.delete", "admin:write", "admin", "normal", "5"],

  // Identity, tokens and admin
  ["GET", "/me", "actor.get", "any", "viewer", "read", "2"],
  ["GET", "/me/portfolio", "portfolio.get", "session_only", "admin", "read", "3"],
  ["POST", "/orgs", "org.create", "session_only", "none", "normal", "2"],
  ["GET", "/approvals", "approval.list", "any", "viewer", "read", "2"],
  ["GET", "/approvals/{id}", "approval.get", "any", "viewer", "read", "2"],
  ["POST", "/approvals/{id}/decide", "approval.decide", "session_only", "requested_operation", "normal", "2"],
  ["GET", "/agent-tokens", "agent_token.list", "admin:write", "viewer", "read", "2"],
  ["POST", "/agent-tokens", "agent_token.create", "admin:write", "viewer", "high*", "2"],
  ["DELETE", "/agent-tokens/{id}", "agent_token.revoke", "admin:write", "viewer", "safety", "2"],
  ["GET", "/members", "member.list", "admin:write", "admin", "read", "2"],
  ["POST", "/invitations", "member.invite", "admin:write", "admin", "high", "2"],
  ["PATCH", "/members/{userId}", "member.role_change", "admin:write", "admin", "high", "2"],
  ["DELETE", "/members/{userId}", "member.remove", "admin:write", "admin", "high", "2"],
  ["GET", "/keys", "key.get", "admin:write", "admin", "read", "2"],
  ["POST", "/keys/rotate", "key.rotate", "admin:write", "admin", "high", "2"],
  ["DELETE", "/keys", "key.revoke", "admin:write", "admin", "high", "2"],
  ["GET", "/settings", "settings.get", "sets:read", "viewer", "read", "2"],
  ["PATCH", "/settings", "settings.update", "admin:write", "admin", "high*", "2"],
  ["GET", "/price-book", "price_book.get", "reports:read", "viewer", "read", "2"],
  ["PUT", "/price-book", "price_book.update", "admin:write", "admin", "normal", "2"],
  ["GET", "/plugins", "plugin.list", "sets:read", "viewer", "read", "5"],
  ["GET", "/plugins/{id}", "plugin.get", "sets:read", "viewer", "read", "5"],
  ["PATCH", "/plugins/{id}", "plugin.update", "admin:write", "admin", "normal", "5"],
  ["DELETE", "/org", "org.delete", "admin:write", "owner", "high", "3"],

  // Platform (platform admin only)
  ["GET", "/platform/models", "platform_model.list", "platform_admin", "superadmin", "read", "3"],
  ["POST", "/platform/models", "platform_model.create", "platform_admin", "superadmin", "normal", "3"],
  ["PATCH", "/platform/models/{id}", "platform_model.update", "platform_admin", "superadmin", "normal", "3"],
  ["GET", "/platform/price-book", "platform_price_book.get", "platform_admin", "superadmin", "read", "2"],
  ["PUT", "/platform/price-book", "platform_price_book.update", "platform_admin", "superadmin", "normal", "2"],
  ["GET", "/platform/settings", "platform_settings.get", "platform_admin", "superadmin", "read", "2"],
  ["PATCH", "/platform/settings", "platform_settings.update", "platform_admin", "superadmin", "normal", "2"],
  ["GET", "/platform/orgs", "platform_org.list", "platform_admin", "superadmin", "read", "2"],
  ["POST", "/platform/orgs/{id}/suspend", "platform_org.suspend", "platform_admin", "superadmin", "normal", "2"],
  ["PUT", "/platform/orgs/{id}/entitlements", "platform_org.set_entitlement", "platform_admin", "superadmin", "normal", "2"],
  ["GET", "/platform/early-access", "platform_early_access.list", "platform_admin", "superadmin", "read", "2"],
  ["POST", "/platform/early-access/remove", "platform_early_access.remove", "platform_admin", "superadmin", "normal", "2"],
  ["GET", "/platform/reports/{name}", "platform_report.get", "platform_admin", "superadmin", "read", "3"],
] as const);

export type OperationId = (typeof OPERATION_CATALOG)[number]["id"];

/**
 * Routes that are not operations: the device flow runs before any tenant context exists, and the
 * two public documents have none. The parity test skips them.
 */
export const NON_OPERATION_ROUTES = [
  { method: "POST", path: `${API_PREFIX}/auth/device/code`, phase: "2" },
  { method: "POST", path: `${API_PREFIX}/auth/device/token`, phase: "2" },
  { method: "GET", path: `${API_PREFIX}/.well-known/jwks.json`, phase: "2" },
  { method: "GET", path: `${API_PREFIX}/openapi.json`, phase: "0" },
] as const satisfies readonly { method: HttpMethod; path: string; phase: Phase }[];

/** Operations app tokens (sk_, pk_, browser) can reach, subject to their scopes. */
export const APP_TOKEN_OPERATIONS = [
  "set.run",
  "set.list",
  "set.manifest",
  "version.get",
  "model.list",
  "run.list",
  "run.get",
  "run.ingest",
  "usage.get",
  "review.list",
  "review.assign",
  "review.resolve",
  "review.dismiss",
  "feedback.report",
  "event.list",
  "browser_token.create",
] as const satisfies readonly OperationId[];

/** Operations a job calls as the system actor. */
export const SYSTEM_ACTOR_OPERATIONS = ["rollout.change", "experiment.stop"] as const satisfies readonly OperationId[];

/** When each high* row needs an approval for an agent. */
export const HIGH_RISK_CONDITIONS = {
  "set.publish":
    "The channel is production and the set is protected or its production stage is controlled or full. With skipExperiment it is always high.",
  "channel.promote":
    "The set is protected or its production stage is controlled or full. With skipExperiment it is always high.",
  "rollout.change":
    "A move into controlled or full from a lower stage, or any move out of paused. Moves into paused, down from full or controlled, and inactive to shadow are never gated.",
  "set.update":
    "The change moves storageMode to a less private mode: hash_only to redacted or full, or redacted to full.",
  "experiment.start": "samplePct above 0.25.",
  "app_token.create":
    "The new token has a write scope, except feedback:write on an sk_test_ token bound to staging.",
  "agent_token.create": "The new token has a write scope. An admin:write token is always gated.",
  "settings.update": "The change touches PII mode or retention, or lowers agentApprovals.",
} as const satisfies Partial<Record<OperationId, string>>;

/** A catalog row with no org in scope: org.create and the platform_* rows (see OrgLessContext). */
export type OrgLessCatalogEntry = Extract<
  (typeof OPERATION_CATALOG)[number],
  { scope: "platform_admin" } | { scope: "session_only"; minRole: "none" }
>;

export type OrgLessOperationId = OrgLessCatalogEntry["id"];

/** True when the row runs without an org, so its handler takes an OperationContext. */
export function runsWithoutOrg(entry: Pick<OperationCatalogEntry, "scope" | "minRole">): boolean {
  return entry.scope === "platform_admin" || (entry.scope === "session_only" && entry.minRole === "none");
}

/** The context an operation's handler receives. */
export type OperationContextFor<Id extends OperationId> = Id extends OrgLessOperationId
  ? OperationContext
  : TenantContext;

/** The actors a catalog row allows. */
export function catalogActors(entry: Pick<OperationCatalogEntry, "id" | "scope">): OperationActor[] {
  if (entry.scope === "session_only" || entry.scope === "platform_admin") return ["user"];
  if (entry.id === "browser_token.create") return ["apiKey"];
  const actors: OperationActor[] = [...DEFAULT_OPERATION_ACTORS];
  if ((APP_TOKEN_OPERATIONS as readonly string[]).includes(entry.id)) actors.push("apiKey");
  if ((SYSTEM_ACTOR_OPERATIONS as readonly string[]).includes(entry.id)) actors.push("system");
  return actors;
}

/** Look up a catalog row by id. */
export function catalogEntry(id: OperationId): OperationCatalogEntry {
  const entry = OPERATION_CATALOG.find((e) => e.id === id);
  if (entry === undefined) throw new Error(`unknown operation ${id}`);
  return entry;
}

// Compile-time check: OperationActor matches the TenantContext actor kinds.
type _AssertTrue<T extends true> = T;
type _ActorsMatch = _AssertTrue<
  OperationActor extends ActorKind ? (ActorKind extends OperationActor ? true : false) : false
>;
