// Store interfaces and the row shapes they return.
//
// Store methods take the TenantContext and run inside withTenant, in the caller's transaction.
// packages/db implements them with repositories. Row schemas are camelCase versions of
// the documented columns (Drizzle maps between them). They strip unknown keys, so a column added
// by a later migration does not break an older reader.

import { z } from "zod";

import {
  Action,
  ActorType,
  ApprovalId,
  AppId,
  Band,
  Channel,
  Client,
  DecisionId,
  type EpochMs,
  ExperimentArm,
  ExperimentId,
  GoalId,
  IsoTimestamp,
  JsonValue,
  KeyMode,
  MicroUsd,
  OrgId,
  type Page,
  type PageReq,
  PointerChannel,
  ProjectId,
  QuestionId,
  ReleaseKind,
  ReviewItemId,
  Role,
  RolloutStage,
  RunId,
  SavingsKind,
  SetId,
  StorageMode,
  TokenCount,
  TokenId,
  UserId,
  VersionId,
} from "./common.js";
import { EventEnvelope, EventType } from "./events.js";
import { FailureClass, type FeedbackReport, LabelingPolicy } from "./learning.js";
import { CounterfactualMode, Decision, RunStage, RunStatus, SavingsSuppressed } from "./run.js";
import { QuestionSetSpec, RunSource } from "./spec.js";
import { SystemOneAnswer } from "./system-one.js";
import type { OrgLessContext, TenantContext } from "./tenant.js";

// ---------------------------------------------------------------------------
// Sets

/** question_sets.value_settings: feeds the quality-adjusted value. */
export const ValueSettings = z.strictObject({
  errorCostUsd: z.number().nonnegative(),
  reviewCostUsd: z.number().nonnegative(),
});
export type ValueSettings = z.infer<typeof ValueSettings>;

/** question_sets.gate_margins: the regression gate and experiment promotion margins. */
export const GateMargins = z.strictObject({
  coverageDrop: z.number().min(0).max(1),
  reviewLoadRise: z.number().min(0),
});
export type GateMargins = z.infer<typeof GateMargins>;

export const DEFAULT_GATE_MARGINS: GateMargins = { coverageDrop: 0.02, reviewLoadRise: 0.1 };

/** A question_sets row. There is no rollout column: the rollout stage lives on release_pointers. */
export const SetRecord = z.object({
  id: SetId,
  orgId: OrgId,
  projectId: ProjectId,
  goalId: GoalId,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  protected: z.boolean(),
  labeling: LabelingPolicy,
  dispatchActionsOnStaging: z.boolean(),
  valueSettings: ValueSettings.nullable(),
  gateMargins: GateMargins,
  storageMode: StorageMode,
  userGenerated: z.boolean(),
  /** Null: the result cache is off. */
  resultCacheTtlSeconds: z.number().int().positive().nullable(),
  draftVersionId: VersionId,
  archivedAt: IsoTimestamp.nullable(),
  createdByUserId: UserId.nullable(),
  createdByTokenId: TokenId.nullable(),
});
export type SetRecord = z.infer<typeof SetRecord>;

/** Which version a `{ref}` asks for. "channel": no suffix, so the caller's channel pointer decides. */
export const VersionSelector = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("channel") }),
  z.strictObject({ kind: z.literal("draft") }),
  z.strictObject({ kind: z.literal("version"), version: z.number().int().positive() }),
]);
export type VersionSelector = z.infer<typeof VersionSelector>;

/** A parsed `{ref}`: the set part (an id or a slug) and the version selector. */
export interface ParsedSetRef {
  set: string;
  selector: VersionSelector;
}

const SET_REF_PATTERN = /^([^@\s]+)(?:@(draft|[1-9][0-9]*))?$/;

/** Parse `id`, `slug`, `slug@7` or `slug@draft`. Null for anything else. */
export function parseSetRef(ref: string): ParsedSetRef | null {
  const m = SET_REF_PATTERN.exec(ref);
  if (m === null) return null;
  const [, set, suffix] = m;
  if (set === undefined) return null;
  if (suffix === undefined) return { set, selector: { kind: "channel" } };
  if (suffix === "draft") return { set, selector: { kind: "draft" } };
  return { set, selector: { kind: "version", version: Number(suffix) } };
}

export const ResolvedSetRef = z.object({ set: SetRecord, selector: VersionSelector });
export type ResolvedSetRef = z.infer<typeof ResolvedSetRef>;

export interface SetStore {
  /**
   * Resolve a `{ref}` (id, slug, slug@7 or slug@draft) to the set row and the version selector.
   * Null when no set in the caller's org matches, which the operation returns as 404.
   */
  resolveRef(ctx: TenantContext, ref: string): Promise<ResolvedSetRef | null>;
}

// ---------------------------------------------------------------------------
// Versions and pointers

export const VersionStatus = z.enum(["draft", "published", "archived"]);
export type VersionStatus = z.infer<typeof VersionStatus>;

/** question_set_versions.source. */
export const VersionSource = z.enum(["console", "api", "cli", "mcp", "studio", "upgrade", "proposal"]);
export type VersionSource = z.infer<typeof VersionSource>;

/** A question_set_versions row. */
export const VersionRecord = z.object({
  id: VersionId,
  orgId: OrgId,
  setId: SetId,
  version: z.number().int().positive(),
  status: VersionStatus,
  spec: QuestionSetSpec,
  specHash: z.string().min(1),
  interfaceHash: z.string().min(1),
  interfaceMajor: z.number().int().nonnegative(),
  model: z.string().min(1),
  changelog: z.string().nullable(),
  source: VersionSource,
  /** Commit SHA. */
  sourceRef: z.string().nullable(),
  createdByUserId: UserId.nullable(),
  createdByTokenId: TokenId.nullable(),
  publishedByUserId: UserId.nullable(),
  publishedByTokenId: TokenId.nullable(),
  publishedAt: IsoTimestamp.nullable(),
  evalRunId: z.uuid().nullable(),
});
export type VersionRecord = z.infer<typeof VersionRecord>;

/** A release_pointers row. The only place the rollout stage is stored. */
export const Pointer = z.object({
  orgId: OrgId,
  setId: SetId,
  channel: PointerChannel,
  versionId: VersionId,
  rolloutStage: RolloutStage,
  activeExperimentId: ExperimentId.nullable(),
  updatedAt: IsoTimestamp,
});
export type Pointer = z.infer<typeof Pointer>;

export const PutDraftResult = z.object({ etag: z.string().min(1) });
export type PutDraftResult = z.infer<typeof PutDraftResult>;

export const DraftRecord = z.object({
  versionId: VersionId,
  spec: QuestionSetSpec,
  /** The draft's spec_hash. */
  etag: z.string().min(1),
});
export type DraftRecord = z.infer<typeof DraftRecord>;

export const ChannelVersion = z.object({ pointer: Pointer, version: VersionRecord });
export type ChannelVersion = z.infer<typeof ChannelVersion>;

export const PublishVersionInput = z.strictObject({
  setId: SetId,
  ifMatch: z.string().min(1),
  changelog: z.string(),
  interfaceMajor: z.number().int().nonnegative(),
  interfaceHash: z.string().min(1),
  source: VersionSource,
  sourceRef: z.string().nullable(),
});
export type PublishVersionInput = z.infer<typeof PublishVersionInput>;

export const MovePointerInput = z.strictObject({
  setId: SetId,
  channel: PointerChannel,
  toVersionId: VersionId,
  kind: ReleaseKind,
  reason: z.string().nullable(),
  /** release_events.approval_id: the approval an agent operation ran under, else null. */
  approvalId: ApprovalId.nullable(),
});
export type MovePointerInput = z.infer<typeof MovePointerInput>;

export const SetRolloutStageInput = z.strictObject({
  setId: SetId,
  channel: PointerChannel,
  to: RolloutStage,
  kind: z.enum(["rollout_change", "auto_demote"]),
  reason: z.string(),
  /** release_events.approval_id: the approval an agent operation ran under, else null. */
  approvalId: ApprovalId.nullable(),
});
export type SetRolloutStageInput = z.infer<typeof SetRolloutStageInput>;

export const SetActiveExperimentInput = z.strictObject({
  setId: SetId,
  channel: PointerChannel,
  experimentId: ExperimentId.nullable(),
});
export type SetActiveExperimentInput = z.infer<typeof SetActiveExperimentInput>;

export interface VersionStore {
  getDraft(ctx: TenantContext, setId: SetId): Promise<DraftRecord>;
  /** Throws 412 precondition_failed on an ETag mismatch. */
  putDraft(ctx: TenantContext, setId: SetId, spec: QuestionSetSpec, ifMatch: string): Promise<PutDraftResult>;
  getVersion(ctx: TenantContext, setId: SetId, n: number): Promise<VersionRecord | null>;
  getVersionById(ctx: TenantContext, versionId: VersionId): Promise<VersionRecord | null>;
  getByChannel(ctx: TenantContext, setId: SetId, channel: PointerChannel): Promise<ChannelVersion | null>;
  listVersions(ctx: TenantContext, setId: SetId, page: PageReq): Promise<Page<VersionRecord>>;
  /** Freezes the draft into N+1 and opens a new draft. Moves no pointer. */
  publish(ctx: TenantContext, input: PublishVersionInput): Promise<VersionRecord>;
  /** Creates the pointer at "inactive" when none exists. Writes release_events. */
  movePointer(ctx: TenantContext, input: MovePointerInput): Promise<Pointer>;
  setRolloutStage(ctx: TenantContext, input: SetRolloutStageInput): Promise<Pointer>;
  setActiveExperiment(ctx: TenantContext, input: SetActiveExperimentInput): Promise<Pointer>;
}

// ---------------------------------------------------------------------------
// Runs

/** runs.source: every RunSource plus "ingest", which never goes through runQuestionSet. */
export const RunRecordSource = z.enum([...RunSource.options, "ingest"]);
export type RunRecordSource = z.infer<typeof RunRecordSource>;

/** A runs row. Money columns are integer micro-USD. */
export const RunRecord = z.object({
  id: RunId,
  orgId: OrgId,
  projectId: ProjectId,
  setId: SetId,
  versionId: VersionId,
  channel: Channel,
  rollout: RolloutStage,
  experimentId: ExperimentId.nullable(),
  arm: ExperimentArm.nullable(),
  /** Set on a linked run started by a `set` fallback: the parent run. */
  parentRunId: RunId.nullable(),
  source: RunRecordSource,
  appId: AppId.nullable(),
  actorUserId: UserId.nullable(),
  actorTokenId: TokenId.nullable(),
  keyMode: KeyMode,
  modelRequested: z.string().min(1),
  modelResolved: z.string().min(1).nullable(),
  typesafeRequestId: z.string().nullable(),
  interfaceMajor: z.number().int().nonnegative(),
  externalRef: z.string().nullable(),
  /** Null for hash-only sets and after state retention. */
  state: JsonValue.nullable(),
  stateHash: z.string().min(1),
  /** result.stages as returned, with every call. */
  stages: z.array(RunStage),
  /**
   * spec.checks results by check id. Kept after the state purge, so policy replay can re-evaluate
   * relevantWhen and routes that read checks.
   */
  checks: z.record(DecisionId, z.boolean()),
  /** Always the full SystemOneAnswer JSON, including probabilities. */
  answers: z.record(QuestionId, SystemOneAnswer),
  decisions: z.record(DecisionId, Decision),
  runBand: Band,
  overallAction: Action,
  route: z.string().nullable(),
  warnings: z.array(z.string()),
  /** System One tokens. */
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  /** Null when the resolved model has no price row in BYO key mode. */
  systemOneCostMicroUsd: MicroUsd.nullable(),
  systemOneCalls: TokenCount,
  cfInputTokens: TokenCount,
  cfOutputTokens: TokenCount,
  counterfactualMicroUsd: MicroUsd,
  counterfactualMode: CounterfactualMode,
  comparatorModel: z.string().min(1),
  savingsMicroUsd: MicroUsd,
  savingsKind: SavingsKind,
  savingsSuppressed: SavingsSuppressed.nullable(),
  escalationCostMicroUsd: MicroUsd,
  llmCallsMade: TokenCount,
  llmCallsAvoided: TokenCount,
  contextTokensPruned: z.number().int().nullable(),
  latencyMs: z.number().int().nonnegative(),
  status: RunStatus,
  /** RunResult.error.code. A plain string, so a code added later in v1 still parses. */
  errorCode: z.string().nullable(),
  createdAt: IsoTimestamp,
});
export type RunRecord = z.infer<typeof RunRecord>;

export const RunListFilter = z.strictObject({
  setId: SetId.optional(),
  version: z.number().int().positive().optional(),
  channel: Channel.optional(),
  source: RunRecordSource.optional(),
  status: RunStatus.optional(),
  band: Band.optional(),
  action: Action.optional(),
  from: IsoTimestamp.optional(),
  to: IsoTimestamp.optional(),
});
export type RunListFilter = z.infer<typeof RunListFilter>;

/** Runs are written only by RunSink. */
export interface RunStore {
  get(ctx: TenantContext, runId: RunId): Promise<RunRecord | null>;
  list(ctx: TenantContext, filter: RunListFilter, page: PageReq): Promise<Page<RunRecord>>;
  /** Feedback matching. */
  findByExternalRef(ctx: TenantContext, externalRef: string, setId?: SetId): Promise<RunRecord | null>;
}

// ---------------------------------------------------------------------------
// Review

export const ReviewItemKind = z.enum(["action", "label"]);
export type ReviewItemKind = z.infer<typeof ReviewItemKind>;

export const ReviewItemReason = z.enum(["action", "audit", "near_threshold", "challenger_diff", "studio"]);
export type ReviewItemReason = z.infer<typeof ReviewItemReason>;

/** pending_confirmation: an agent resolved an action item and a person must confirm it. */
export const ReviewItemStatus = z.enum(["open", "pending_confirmation", "resolved", "dismissed"]);
export type ReviewItemStatus = z.infer<typeof ReviewItemStatus>;

/** A review_items row. */
export const ReviewItem = z.object({
  id: ReviewItemId,
  orgId: OrgId,
  /** Null for Studio items. */
  runId: RunId.nullable(),
  studioExampleId: z.uuid().nullable(),
  setId: SetId,
  decisionId: DecisionId,
  kind: ReviewItemKind,
  reason: ReviewItemReason,
  /** Set when the random audit picked the decision. Metrics weight it by 1 / sampleRate. */
  sampleRate: z.number().gt(0).lte(1).nullable(),
  band: Band,
  suggested: z.unknown(),
  status: ReviewItemStatus,
  assigneeId: UserId.nullable(),
  resolution: z.unknown(),
  resolvedByUserId: UserId.nullable(),
  resolvedByTokenId: TokenId.nullable(),
  resolvedAt: IsoTimestamp.nullable(),
  dueAt: IsoTimestamp.nullable(),
  addToDataset: z.boolean(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const ReviewListFilter = z.strictObject({
  setId: SetId.optional(),
  kind: ReviewItemKind.optional(),
  status: ReviewItemStatus.optional(),
  assigneeId: UserId.optional(),
});
export type ReviewListFilter = z.infer<typeof ReviewListFilter>;

export const ReviewResolveInput = z.strictObject({
  resolution: z.unknown(),
  addToDataset: z.boolean(),
  pendingConfirmation: z.boolean(),
  /** Why the decision was wrong, when the reviewer set a class. */
  failureClass: FailureClass.optional(),
});
export type ReviewResolveInput = z.infer<typeof ReviewResolveInput>;

export const ReviewConfirmInput = z.strictObject({ resolution: z.unknown().optional() });
export type ReviewConfirmInput = z.infer<typeof ReviewConfirmInput>;

export const FeedbackWriteResult = z.object({
  status: z.enum(["created", "duplicate"]),
  feedbackId: z.uuid(),
});
export type FeedbackWriteResult = z.infer<typeof FeedbackWriteResult>;

export interface ReviewStore {
  list(ctx: TenantContext, filter: ReviewListFilter, page: PageReq): Promise<Page<ReviewItem>>;
  get(ctx: TenantContext, id: ReviewItemId): Promise<ReviewItem | null>;
  assign(ctx: TenantContext, id: ReviewItemId, userId: UserId): Promise<void>;
  resolve(ctx: TenantContext, id: ReviewItemId, input: ReviewResolveInput): Promise<void>;
  /** Sets confirmed_by_user_id and confirmed_at. */
  confirm(ctx: TenantContext, id: ReviewItemId, input: ReviewConfirmInput): Promise<void>;
  dismiss(ctx: TenantContext, id: ReviewItemId, reason: string): Promise<void>;
  /** run_feedback rows; idempotent per item key. */
  addFeedback(ctx: TenantContext, rows: FeedbackReport[]): Promise<FeedbackWriteResult[]>;
}

// ---------------------------------------------------------------------------
// Audit

/** An audit_log row. Append-only. */
export const AuditRow = z.object({
  id: z.uuid(),
  /** Null for platform events. */
  orgId: OrgId.nullable(),
  actorType: ActorType,
  client: Client,
  actorUserId: UserId.nullable(),
  actorTokenId: TokenId.nullable(),
  /** The effective role when the action ran. */
  actorRole: Role.nullable(),
  approvalId: ApprovalId.nullable(),
  impersonatorId: UserId.nullable(),
  /** The operation id, noun.verb. */
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  diff: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: IsoTimestamp,
});
export type AuditRow = z.infer<typeof AuditRow>;

/** Actor, client and role come from ctx. */
export const AuditAppendInput = z.strictObject({
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  diff: z.unknown(),
  approvalId: ApprovalId.nullable(),
});
export type AuditAppendInput = z.infer<typeof AuditAppendInput>;

export const AuditListFilter = z.strictObject({
  action: z.string().optional(),
  actorUserId: UserId.optional(),
  actorTokenId: TokenId.optional(),
  from: IsoTimestamp.optional(),
  to: IsoTimestamp.optional(),
});
export type AuditListFilter = z.infer<typeof AuditListFilter>;

/** Append-only: no update or delete method exists. */
export interface AuditStore {
  append(ctx: TenantContext, row: AuditAppendInput): Promise<void>;
  /**
   * An org_id null row for an operation that runs without an org (org.create before the org
   * exists, the platform_* operations). Written through the audited platform path.
   */
  appendOrgLess(ctx: OrgLessContext, row: AuditAppendInput): Promise<void>;
  list(ctx: TenantContext, filter: AuditListFilter, page: PageReq): Promise<Page<AuditRow>>;
}

// ---------------------------------------------------------------------------
// Approvals

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired", "executed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** An approval_requests row. */
export const Approval = z.object({
  id: ApprovalId,
  orgId: OrgId,
  opId: z.string().min(1),
  /** The stored input, run unchanged on approval. */
  input: z.unknown(),
  inputHash: z.string().min(1),
  /** The If-Match value the request was sent with. */
  ifMatch: z.string().nullable(),
  requestedByTokenId: TokenId,
  requestedByUserId: UserId,
  reason: z.string(),
  status: ApprovalStatus,
  decidedByUserId: UserId.nullable(),
  decidedAt: IsoTimestamp.nullable(),
  expiresAt: IsoTimestamp,
  /** The operation's response, or the error when the re-check stopped it. */
  result: z.unknown(),
  createdAt: IsoTimestamp,
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalCreateInput = z.strictObject({
  opId: z.string().min(1),
  input: z.unknown(),
  inputHash: z.string().min(1),
  ifMatch: z.string().nullable(),
  reason: z.string(),
  expiresAt: IsoTimestamp,
});
export type ApprovalCreateInput = z.infer<typeof ApprovalCreateInput>;

export const ApprovalReuseQuery = z.strictObject({
  tokenId: TokenId,
  opId: z.string().min(1),
  inputHash: z.string().min(1),
});
export type ApprovalReuseQuery = z.infer<typeof ApprovalReuseQuery>;

export const ApprovalListFilter = z.strictObject({
  tokenId: TokenId.optional(),
  decidableByRole: Role.optional(),
});
export type ApprovalListFilter = z.infer<typeof ApprovalListFilter>;

export const ApprovalDecision = z.enum(["approved", "rejected"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalExecution = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), response: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: z.unknown() }),
]);
export type ApprovalExecution = z.infer<typeof ApprovalExecution>;

export interface ApprovalStore {
  /** Pending, or approved or executed in the last 24 hours. */
  findReusable(ctx: TenantContext, input: ApprovalReuseQuery): Promise<Approval | null>;
  create(ctx: TenantContext, input: ApprovalCreateInput): Promise<Approval>;
  get(ctx: TenantContext, id: ApprovalId): Promise<Approval | null>;
  listPending(ctx: TenantContext, filter: ApprovalListFilter, page: PageReq): Promise<Page<Approval>>;
  decide(ctx: TenantContext, id: ApprovalId, decision: ApprovalDecision): Promise<Approval>;
  /** Sets status "executed" and stores the response, or the error when the re-check stopped it. */
  recordResult(ctx: TenantContext, id: ApprovalId, result: ApprovalExecution): Promise<void>;
  /** System job. */
  expireDue(now: EpochMs): Promise<number>;
}

// ---------------------------------------------------------------------------
// Events

export const EventAppendInput = z.strictObject({
  type: EventType,
  subject: z.strictObject({ type: z.string().min(1), id: z.string().min(1) }),
  data: z.unknown(),
});
export type EventAppendInput = z.infer<typeof EventAppendInput>;

export const EventListQuery = z.strictObject({
  after: z.string().nullable(),
  types: z.array(EventType).optional(),
  limit: z.number().int().positive(),
});
export type EventListQuery = z.infer<typeof EventListQuery>;

export const EventListResult = z.object({
  events: z.array(EventEnvelope),
  cursor: z.string().nullable(),
  gap: z.boolean(),
});
export type EventListResult = z.infer<typeof EventListResult>;

export interface EventStore {
  append(ctx: TenantContext, events: EventAppendInput[]): Promise<void>;
  /** Only events older than 5 s. */
  list(ctx: TenantContext, q: EventListQuery): Promise<EventListResult>;
  prune(before: EpochMs): Promise<number>;
}

// ---------------------------------------------------------------------------
// Idempotency

export const IdempotencyEntry = z.object({
  opId: z.string().min(1),
  requestHash: z.string().min(1),
  status: z.number().int(),
  response: z.unknown(),
});
export type IdempotencyEntry = z.infer<typeof IdempotencyEntry>;

export interface IdempotencyStore {
  lookup(ctx: TenantContext, actorKey: string, key: string): Promise<IdempotencyEntry | null>;
  save(ctx: TenantContext, actorKey: string, key: string, entry: IdempotencyEntry): Promise<void>;
  prune(before: EpochMs): Promise<number>;
}
