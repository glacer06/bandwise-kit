// EventEnvelope, EventType and the per-type data schemas.
// Event bodies are responses, so they use z.object: a field added later in v1 is dropped on parse.
// `data` never carries run state, keys or tokens.

import { z } from "zod";

import {
  ActorType,
  AppId,
  Band,
  Client,
  DatasetId,
  DecisionId,
  ExperimentId,
  ExperimentKind,
  IsoTimestamp,
  JsonObject,
  JsonValue,
  OrgId,
  PointerChannel,
  ProposalKind,
  RolloutStage,
  RunId,
  SetId,
  TokenId,
  UserId,
  Uuid,
  VersionId,
} from "./common.js";
import { GateResult } from "./errors.js";
import { FailureClass } from "./learning.js";
import { SystemOneProvider } from "./system-one.js";
// stores.ts imports this file at runtime, so only types come back the other way. The enums below
// repeat stores.ts values, and the checks at the end of this file keep them equal.
import type { ReviewItemKind, ReviewItemReason, VersionSource } from "./stores.js";

// ---------------------------------------------------------------------------
// Catalog

/** Tenant events. */
export const TENANT_EVENT_TYPES = [
  "set.published",
  "release.rolled_back",
  "release.promoted",
  "rollout.changed",
  "rollout.auto_demoted",
  "rollout.gate_met",
  "eval.completed",
  "job.completed",
  "review.created",
  "review.sla_breached",
  "review.resolved",
  "alert.raised",
  "model.available",
  "model.alias_moved",
  "model.deprecated",
  "proposal.created",
  "experiment.started",
  "experiment.decided",
  "approval.requested",
  "approval.decided",
  "key.invalid",
  "interface.breaking_published",
  "binding.created",
] as const;

/** Platform-only events: `org_id` null, read only through the platform admin path. */
export const PLATFORM_EVENT_TYPES = ["contract.changed", "model.unreviewed"] as const;

export const EVENT_TYPES = [...TENANT_EVENT_TYPES, ...PLATFORM_EVENT_TYPES] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export type TenantEventType = (typeof TENANT_EVENT_TYPES)[number];
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export function isPlatformEventType(type: EventType): type is PlatformEventType {
  return (PLATFORM_EVENT_TYPES as readonly string[]).includes(type);
}

/** The `subject.type` values each event type may carry. */
export const EVENT_SUBJECT_TYPES = {
  "set.published": ["set"],
  "release.rolled_back": ["set"],
  "release.promoted": ["set"],
  "rollout.changed": ["set"],
  "rollout.auto_demoted": ["set"],
  "rollout.gate_met": ["set"],
  "eval.completed": ["eval_run"],
  "job.completed": ["job"],
  "review.created": ["review_item"],
  "review.sla_breached": ["review_item"],
  "review.resolved": ["review_item"],
  "alert.raised": ["set", "org"],
  "model.available": ["model"],
  "model.alias_moved": ["model"],
  "model.deprecated": ["model"],
  "proposal.created": ["proposal"],
  "experiment.started": ["experiment"],
  "experiment.decided": ["experiment"],
  "approval.requested": ["approval"],
  "approval.decided": ["approval"],
  "key.invalid": ["key"],
  "interface.breaking_published": ["set"],
  "binding.created": ["binding"],
  "contract.changed": ["contract"],
  "model.unreviewed": ["model"],
} as const satisfies Record<EventType, readonly string[]>;

// ---------------------------------------------------------------------------
// Data shapes, one per event type

/** Free-form metric summaries (never run state). */
const Metrics = JsonObject;

/** A version as a run or eval names it: a number, or the mutable draft. */
const VersionRef = z.union([z.number().int().positive(), z.literal("draft")]);

/** review_items.kind. */
const EventReviewKind = z.enum(["action", "label"]);
/** review_items.reason. */
const EventReviewReason = z.enum(["action", "audit", "near_threshold", "challenger_diff", "studio"]);
/** question_set_versions.source. */
const EventVersionSource = z.enum(["console", "api", "cli", "mcp", "studio", "upgrade", "proposal"]);

/** Job kinds. */
export const JobKind = z.enum(["eval", "compare", "calibrate", "improve", "try_model", "policy_suggest", "export"]);
export type JobKind = z.infer<typeof JobKind>;

/** jobs.status. */
export const JobStatus = z.enum(["queued", "running", "succeeded", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

/** A failed job's error: the envelope's code and message. */
export const JobError = z.object({ code: z.string().min(1), message: z.string() });
export type JobError = z.infer<typeof JobError>;

export const SetPublishedData = z.object({
  channel: PointerChannel,
  version: z.number().int().positive(),
  versionId: VersionId,
  /** Null on the channel's first publish. */
  fromVersionId: VersionId.nullable(),
  interfaceMajor: z.number().int().nonnegative(),
  interfaceHash: z.string().min(1),
  changelog: z.string(),
  source: EventVersionSource,
});

export const ReleaseRolledBackData = z.object({
  channel: PointerChannel,
  fromVersionId: VersionId,
  toVersionId: VersionId,
  toVersion: z.number().int().positive(),
});

export const ReleasePromotedData = z.object({
  channel: PointerChannel,
  /** Null when the promote created the pointer. */
  fromVersionId: VersionId.nullable(),
  toVersionId: VersionId,
  toVersion: z.number().int().positive(),
  experimentId: ExperimentId.optional(),
});

export const RolloutChangedData = z.object({
  channel: PointerChannel,
  from: RolloutStage,
  to: RolloutStage,
  reason: z.string(),
});

export const RolloutAutoDemotedData = z.object({
  channel: PointerChannel,
  from: RolloutStage,
  to: RolloutStage,
  rule: z.enum(["precision_below_target", "band_drift", "model_changed"]),
  metrics: Metrics,
});

export const RolloutGateMetData = z.object({
  channel: PointerChannel,
  stage: RolloutStage,
  nextStage: RolloutStage,
  gates: z.array(GateResult),
});

export const EvalCompletedData = z.object({
  setId: SetId,
  version: VersionRef,
  datasetId: DatasetId,
  snapshotId: Uuid,
  model: z.string().min(1),
  status: z.enum(["succeeded", "failed"]),
  metrics: Metrics,
});

export const JobCompletedData = z.object({
  kind: JobKind,
  status: z.enum(["succeeded", "failed"]),
  error: JobError.optional(),
});

export const ReviewCreatedData = z.object({
  setId: SetId,
  /** Null for Studio label items, which have no run. */
  runId: RunId.nullable(),
  decisionId: DecisionId,
  kind: EventReviewKind,
  reason: EventReviewReason,
  band: Band,
  dueAt: IsoTimestamp.nullable(),
});

export const ReviewSlaBreachedData = z.object({
  setId: SetId,
  dueAt: IsoTimestamp,
  assigneeId: UserId.nullable(),
});

export const ReviewResolution = z.object({
  value: JsonValue,
  /** True when the server dispatched the decision's policy handler. */
  execute: z.boolean(),
  /** Why the decision was wrong, when the reviewer set a class. */
  failureClass: FailureClass.optional(),
});
export type ReviewResolution = z.infer<typeof ReviewResolution>;

export const ReviewResolvedData = z.object({
  setId: SetId,
  runId: RunId.nullable(),
  /** The run's options.externalRef, or null. */
  externalRef: z.string().nullable(),
  decisionId: DecisionId,
  kind: EventReviewKind,
  status: z.enum(["resolved", "dismissed"]),
  /** Null when dismissed. */
  resolution: ReviewResolution.nullable(),
  resolvedByUserId: UserId.optional(),
  resolvedByTokenId: TokenId.optional(),
});

/**
 * `set_silent`: a set that normally produces decisions on a channel produced none, or
 * only errors, for its liveness window.
 *
 * `escalation_over_budget`: a set's escalation spend for the day crossed its daily
 * escalation budget. It alerts only and does not stop escalating.
 */
export const AlertKind = z.enum([
  "band_drift",
  "precision_below_target",
  "no_truth_source",
  "rate_headroom",
  "quota",
  "set_silent",
  "escalation_over_budget",
]);
export type AlertKind = z.infer<typeof AlertKind>;

export const AlertSeverity = z.enum(["info", "warning", "critical"]);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const AlertRaisedData = z.object({
  kind: AlertKind,
  severity: AlertSeverity,
  message: z.string(),
  metrics: Metrics,
});

/** YYYY-MM-DD. */
const IsoDate = z.iso.date();

export const ModelAvailableData = z.object({
  modelId: z.string().min(1),
  family: z.string().min(1),
  status: z.enum(["preview", "stable"]),
  releaseDate: IsoDate.nullable(),
  /**
   * The org's upgrade candidates: live sets pinned to an
   * older model in the same family, or to a model or family in the new model's `supersedes`, whose
   * question types the new model covers.
   */
  candidateSetIds: z.array(SetId),
  /** The subset of candidateSetIds found only through `supersedes`, marked cross-family. */
  crossFamilySetIds: z.array(SetId),
}).refine((d) => d.crossFamilySetIds.every((id) => d.candidateSetIds.includes(id)), {
  path: ["crossFamilySetIds"],
  message: "every cross-family set is also a candidate",
});

export const ModelAliasMovedData = z.object({
  /**
   * Which provider's alias moved: OpenRouter's `~typesafe/jev-latest` can point at a
   * different build than TypeSafe's `jev-latest`. Absent on events from before provider routes existed, which were
   * typesafe. For an OpenRouter route the ids are OpenRouter ids.
   */
  provider: SystemOneProvider.optional(),
  alias: z.string().min(1),
  /** Null the first time an alias target is observed. */
  fromResolvedId: z.string().min(1).nullable(),
  toResolvedId: z.string().min(1),
  affectedSetIds: z.array(SetId),
});

export const ModelDeprecatedData = z.object({
  modelId: z.string().min(1),
  status: z.enum(["deprecated", "retired"]),
  retireAt: IsoDate.nullable(),
  pinnedSetIds: z.array(SetId),
});

export const ProposalCreatedData = z.object({
  setId: SetId,
  kind: ProposalKind,
  metricsDelta: Metrics,
});

export const ExperimentStartedData = z.object({
  setId: SetId,
  channel: PointerChannel,
  kind: ExperimentKind,
  championVersionId: VersionId,
  challengerVersionId: VersionId,
  /** Share of runs, 0 to 1. */
  samplePct: z.number().min(0).max(1),
});

export const ExperimentDecidedData = z.object({
  setId: SetId,
  outcome: z.enum(["promoted", "stopped"]),
  result: Metrics,
});

export const ApprovalRequestedData = z.object({
  /** The requested operation id. */
  opId: z.string().min(1),
  requestedByUserId: UserId,
  requestedByTokenId: TokenId,
  /** The input's reason or changelog, when it has one. */
  reason: z.string().nullable(),
  url: z.url(),
  expiresAt: IsoTimestamp,
});

export const ApprovalDecidedData = z.object({
  opId: z.string().min(1),
  status: z.enum(["approved", "rejected", "expired"]),
  /** Absent on expiry. */
  decidedByUserId: UserId.optional(),
});

export const KeyInvalidData = z.object({
  keyLast4: z.string().length(4),
  reason: z.string(),
});

export const InterfaceBreakingPublishedData = z.object({
  channel: PointerChannel,
  version: z.number().int().positive(),
  fromMajor: z.number().int().nonnegative(),
  toMajor: z.number().int().nonnegative(),
  /** The interfaceBump reason. */
  reason: z.string(),
  bindingIds: z.array(Uuid),
});

export const BindingCreatedData = z.object({
  appId: AppId,
  setId: SetId,
  channel: PointerChannel,
  /** app_set_bindings.target. */
  target: z.enum(["managed", "managed_typed", "standalone"]),
  interfaceMajor: z.number().int().nonnegative(),
});

export const ContractChangedData = z.object({
  source: z.enum(["openapi", "llms_txt", "models_md"]),
  changes: z.array(JsonValue),
});

export const ModelUnreviewedData = z.object({
  modelId: z.string().min(1),
  seenVia: z.enum(["list", "observation"]),
});

/** The data schema for each event type. */
export const EVENT_DATA = {
  "set.published": SetPublishedData,
  "release.rolled_back": ReleaseRolledBackData,
  "release.promoted": ReleasePromotedData,
  "rollout.changed": RolloutChangedData,
  "rollout.auto_demoted": RolloutAutoDemotedData,
  "rollout.gate_met": RolloutGateMetData,
  "eval.completed": EvalCompletedData,
  "job.completed": JobCompletedData,
  "review.created": ReviewCreatedData,
  "review.sla_breached": ReviewSlaBreachedData,
  "review.resolved": ReviewResolvedData,
  "alert.raised": AlertRaisedData,
  "model.available": ModelAvailableData,
  "model.alias_moved": ModelAliasMovedData,
  "model.deprecated": ModelDeprecatedData,
  "proposal.created": ProposalCreatedData,
  "experiment.started": ExperimentStartedData,
  "experiment.decided": ExperimentDecidedData,
  "approval.requested": ApprovalRequestedData,
  "approval.decided": ApprovalDecidedData,
  "key.invalid": KeyInvalidData,
  "interface.breaking_published": InterfaceBreakingPublishedData,
  "binding.created": BindingCreatedData,
  "contract.changed": ContractChangedData,
  "model.unreviewed": ModelUnreviewedData,
} as const satisfies Record<EventType, z.ZodType>;

export type EventData<T extends EventType> = z.infer<(typeof EVENT_DATA)[T]>;

// ---------------------------------------------------------------------------
// Envelope

export const EventActor = z.object({
  type: ActorType,
  userId: UserId.optional(),
  tokenId: TokenId.optional(),
  client: Client.optional(),
});
export type EventActor = z.infer<typeof EventActor>;

export const EventSubject = z.object({
  /** For example "set", "review_item", "model". */
  type: z.string().min(1),
  id: z.string().min(1),
});
export type EventSubject = z.infer<typeof EventSubject>;

/**
 * One event. Parsing checks `data` against the schema for `type`, `subject.type` against the
 * catalog, and that `orgId` is null exactly for platform-only events.
 */
export const EventEnvelope = z
  .object({
    /** uuidv7; also the feed cursor. */
    id: Uuid,
    type: EventType,
    /** Null only for platform-only events. */
    orgId: OrgId.nullable(),
    occurredAt: IsoTimestamp,
    actor: EventActor,
    subject: EventSubject,
    /** Per type; see EVENT_DATA. */
    data: z.unknown(),
  })
  .superRefine((e, ctx) => {
    const platform = isPlatformEventType(e.type);
    if (platform && e.orgId !== null) {
      ctx.addIssue({ code: "custom", path: ["orgId"], message: `${e.type} is platform-only; orgId must be null` });
    }
    if (!platform && e.orgId === null) {
      ctx.addIssue({ code: "custom", path: ["orgId"], message: `${e.type} is a tenant event; orgId is required` });
    }
    const subjects: readonly string[] = EVENT_SUBJECT_TYPES[e.type];
    if (!subjects.includes(e.subject.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["subject", "type"],
        message: `${e.type} has subject ${subjects.join(" or ")}, not ${e.subject.type}`,
      });
    }
    const data = EVENT_DATA[e.type].safeParse(e.data);
    if (!data.success) {
      for (const issue of data.error.issues) {
        ctx.addIssue({ code: "custom", path: ["data", ...issue.path], message: issue.message });
      }
    }
  });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** An envelope whose `data` is typed by its event type. */
export type TypedEventEnvelope<T extends EventType = EventType> = T extends EventType
  ? Omit<EventEnvelope, "type" | "data"> & { type: T; data: EventData<T> }
  : never;

/** Parse `data` for a known type. Throws a ZodError when it does not match. */
export function parseEventData<T extends EventType>(type: T, data: unknown): EventData<T> {
  return EVENT_DATA[type].parse(data) as EventData<T>;
}

// Compile-time checks: the local enums equal their stores.ts counterparts.
type _AssertTrue<T extends true> = T;
type _Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _ReviewKindMatches = _AssertTrue<_Same<z.infer<typeof EventReviewKind>, ReviewItemKind>>;
type _ReviewReasonMatches = _AssertTrue<_Same<z.infer<typeof EventReviewReason>, ReviewItemReason>>;
type _VersionSourceMatches = _AssertTrue<_Same<z.infer<typeof EventVersionSource>, VersionSource>>;
