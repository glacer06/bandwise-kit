// Shared ids and primitives for every contract file.
// Other contract files import these names; they must not redefine them.

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON

/** Any JSON value. */
export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

export const JsonObject = z.record(z.string(), JsonValue);
export type JsonObject = z.infer<typeof JsonObject>;

export const JsonArray = z.array(JsonValue);
export type JsonArray = z.infer<typeof JsonArray>;

/** Instructions and criteria, sent to System One as written. */
export const Structured = z.union([z.string(), JsonObject, JsonArray]);
export type Structured = z.infer<typeof Structured>;

// ---------------------------------------------------------------------------
// Ids

/** A uuid. Tenant rows use uuidv7 for time-ordered tables. */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

export const OrgId = Uuid;
export type OrgId = Uuid;
export const UserId = Uuid;
export type UserId = Uuid;
export const ProjectId = Uuid;
export type ProjectId = Uuid;
export const GoalId = Uuid;
export type GoalId = Uuid;
export const SetId = Uuid;
export type SetId = Uuid;
export const VersionId = Uuid;
export type VersionId = Uuid;
export const RunId = Uuid;
export type RunId = Uuid;
export const AppId = Uuid;
export type AppId = Uuid;
/** An app token id (`app_tokens.id`). */
export const KeyId = Uuid;
export type KeyId = Uuid;
/** An agent token id (`agent_tokens.id`). */
export const TokenId = Uuid;
export type TokenId = Uuid;
export const ApprovalId = Uuid;
export type ApprovalId = Uuid;
export const ExperimentId = Uuid;
export type ExperimentId = Uuid;
export const ReviewItemId = Uuid;
export type ReviewItemId = Uuid;
export const JobId = Uuid;
export type JobId = Uuid;
export const DatasetId = Uuid;
export type DatasetId = Uuid;

/** Question, composite and check ids share this pattern and one namespace. */
export const ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const QuestionId = z.string().regex(ID_PATTERN);
export type QuestionId = z.infer<typeof QuestionId>;

/** A question id, composite id or check id. One namespace, so every decision has a unique id. */
export const DecisionId = z.string().regex(ID_PATTERN);
export type DecisionId = z.infer<typeof DecisionId>;

/** A scalar answer value. */
export const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Value = z.infer<typeof Value>;

/** Backtick path syntax into state: "email.subject", "items[0].sku". */
export const StatePath = z.string().min(1);
export type StatePath = z.infer<typeof StatePath>;

// ---------------------------------------------------------------------------
// Time and money

/** ISO 8601 timestamp. Stored as timestamptz in UTC; an explicit offset is accepted on input. */
export const IsoTimestamp = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** Epoch milliseconds, as returned by `RunPorts.clock`. */
export const EpochMs = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;

/** Money as integer micro-USD. May be negative (savings can go negative). */
export const MicroUsd = z.number().int().refine(Number.isSafeInteger, "must be a safe integer");
export type MicroUsd = z.infer<typeof MicroUsd>;

/** Price per million tokens in integer micro-USD (`price_books.*_per_mtok_micro_usd`). */
export const MicroUsdPerMtok = z.number().int().nonnegative();
export type MicroUsdPerMtok = z.infer<typeof MicroUsdPerMtok>;

export const TokenCount = z.number().int().nonnegative();
export type TokenCount = z.infer<typeof TokenCount>;

// ---------------------------------------------------------------------------
// Roles, scopes and clients

export const Role = z.enum(["owner", "admin", "editor", "reviewer", "viewer"]);
export type Role = z.infer<typeof Role>;

/** Most to least privileged. `min(role_ceiling, membership role)` uses this order. */
export const ROLE_ORDER = ["owner", "admin", "editor", "reviewer", "viewer"] as const satisfies readonly Role[];

export const PlatformRole = z.enum(["superadmin"]);
export type PlatformRole = z.infer<typeof PlatformRole>;

export const Scope = z.enum([
  "run",
  "sets:read",
  "sets:write",
  "evals:run",
  "release:staging",
  "release:production",
  "runs:read",
  "runs:write",
  "review:read",
  "review:write",
  "feedback:write",
  "usage:read",
  "reports:read",
  "audit:read",
  "events:read",
  "apps:write",
  "admin:write",
]);
export type Scope = z.infer<typeof Scope>;

/** One union for TenantContext.client, EventEnvelope.actor.client and audit_log.client. */
export const Client = z.enum(["console", "api", "cli", "mcp", "extension", "job"]);
export type Client = z.infer<typeof Client>;

/** agent_tokens.client, a subset of Client. */
export const AgentClient = z.enum(["cli", "mcp", "extension", "console"]);
export type AgentClient = z.infer<typeof AgentClient>;

/** audit_log.actor_type. */
export const ActorType = z.enum(["user", "agent", "app", "system"]);
export type ActorType = z.infer<typeof ActorType>;

/** Plan id. The ids themselves are chosen; billing types plans as Record<PlanId, Plan>. */
export const PlanId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export type PlanId = z.infer<typeof PlanId>;

// ---------------------------------------------------------------------------
// Bands and actions

export const Band = z.enum(["high", "medium", "low"]);
export type Band = z.infer<typeof Band>;

/** Highest to lowest certainty. `runBand` is the lowest band among the counted decisions. */
export const BAND_ORDER = ["high", "medium", "low"] as const satisfies readonly Band[];

export const Action = z.enum(["auto", "review", "fallback", "escalate_to_llm"]);
export type Action = z.infer<typeof Action>;

/** Most to least conservative: review > fallback > escalate_to_llm > auto. */
export const ACTION_CONSERVATIVE_ORDER = [
  "review",
  "fallback",
  "escalate_to_llm",
  "auto",
] as const satisfies readonly Action[];

/** Rank of an action; lower is more conservative. */
export function actionRank(action: Action): number {
  return ACTION_CONSERVATIVE_ORDER.indexOf(action);
}

/** The most conservative action of a list, or `fallback` for an empty list. */
export function mostConservativeAction(actions: readonly Action[]): Action {
  let best: Action | null = null;
  for (const a of actions) {
    if (best === null || actionRank(a) < actionRank(best)) best = a;
  }
  return best ?? "fallback";
}

// ---------------------------------------------------------------------------
// Channels and rollout

/** The channel a run resolved through. Pointers exist for production and staging only. */
export const Channel = z.enum(["production", "staging", "pinned", "draft"]);
export type Channel = z.infer<typeof Channel>;

/** A channel that has a release pointer (`release_pointers.channel`). */
export const PointerChannel = z.enum(["production", "staging"]);
export type PointerChannel = z.infer<typeof PointerChannel>;

/** Set per channel on the release pointer, never in the spec. */
export const RolloutStage = z.enum(["inactive", "shadow", "controlled", "full", "paused"]);
export type RolloutStage = z.infer<typeof RolloutStage>;

/** release_events.kind. */
export const ReleaseKind = z.enum([
  "publish",
  "rollback",
  "promote",
  "rollout_change",
  "auto_demote",
  "experiment_start",
  "experiment_promote",
]);
export type ReleaseKind = z.infer<typeof ReleaseKind>;

export const ExperimentArm = z.enum(["champion", "challenger"]);
export type ExperimentArm = z.infer<typeof ExperimentArm>;

/** experiments.kind: what the challenger changes. */
export const ExperimentKind = z.enum(["version", "model", "policy"]);
export type ExperimentKind = z.infer<typeof ExperimentKind>;

/** proposals.kind. */
export const ProposalKind = z.enum([
  "tune_thresholds",
  "model_upgrade",
  "question_fix",
  "add_none_option",
  "split_question",
  "narrow_state",
  "label_more",
  "demote",
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

// ---------------------------------------------------------------------------
// Savings and privacy

export const SavingsKind = z.enum(["decision", "escalation_avoided", "context_pruned"]);
export type SavingsKind = z.infer<typeof SavingsKind>;

/** organizations.pii_mode. */
export const PiiMode = z.enum(["off", "redact_logs", "redact_logs_and_input"]);
export type PiiMode = z.infer<typeof PiiMode>;

/**
 * question_sets.storage_mode: `full` keeps state, `redacted`
 * keeps redacted state, `hash_only` keeps only `runs.state_hash`. Listed from most to least private
 * in STORAGE_MODE_PRIVACY_ORDER.
 */
export const StorageMode = z.enum(["full", "redacted", "hash_only"]);
export type StorageMode = z.infer<typeof StorageMode>;

/** Most to least private. A move toward the end of this list is a PII change. */
export const STORAGE_MODE_PRIVACY_ORDER = ["hash_only", "redacted", "full"] as const satisfies readonly StorageMode[];

/** True when `to` keeps more data than `from` (hash_only to redacted or full, redacted to full). */
export function isLessPrivateStorageMode(from: StorageMode, to: StorageMode): boolean {
  return STORAGE_MODE_PRIVACY_ORDER.indexOf(to) > STORAGE_MODE_PRIVACY_ORDER.indexOf(from);
}

/** organizations.key_mode and KeyResolver's mode. */
export const KeyMode = z.enum(["byo", "platform"]);
export type KeyMode = z.infer<typeof KeyMode>;

// ---------------------------------------------------------------------------
// Pagination (route conventions)

export const PageReq = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
});
export type PageReq = z.infer<typeof PageReq>;

/** `{ data, nextCursor }` for any item schema. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
