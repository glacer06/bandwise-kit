// The run ports: what runQuestionSet needs from the outside world.
//
// Ports are TypeScript interfaces, not zod schemas. Their payloads are zod schemas here, so
// fixtures and mocks validate against them. Each port has an in-memory or fixture implementation
// for tests: most in core, FixtureTransport in system-one-client, the fixture LlmTransport in
// llm-client. Payload schemas are strict: these values never cross a version boundary.

import { z } from "zod";

import {
  Channel,
  DecisionId,
  type EpochMs,
  ExperimentArm,
  ExperimentId,
  KeyMode,
  MicroUsd,
  MicroUsdPerMtok,
  PiiMode,
  type PointerChannel,
  ReviewItemId,
  RolloutStage,
  RunId,
  SetId,
  StorageMode,
  TokenCount,
  VersionId,
} from "./common.js";
import { ErrorCode } from "./errors.js";
import { ModelLimits, ModelProfile, type ModelRoute } from "./models.js";
import { RunResult } from "./run.js";
import { QuestionSetSpec, RunRequest, type RunSource } from "./spec.js";
import { SystemOneProvider, type SystemOneRequest, SystemOneResponse } from "./system-one.js";
import type { TenantContext } from "./tenant.js";

// ---------------------------------------------------------------------------
// Transport errors

/**
 * Internal-only codes a transport may throw besides the documented codes. None of them is ever
 * returned to a caller:
 * - `client_aborted`: the AbortSignal fired. A run
 *   whose budget ran out reports `system_one_unavailable`.
 * - `llm_unavailable`: the LLM provider failed after its retries.
 * - `llm_invalid_reply`: the reply was not one value of the question's type.
 */
export const INTERNAL_TRANSPORT_ERROR_CODES = ["client_aborted", "llm_unavailable", "llm_invalid_reply"] as const;

export const TransportErrorCode = z.union([ErrorCode, z.enum(INTERNAL_TRANSPORT_ERROR_CODES)]);
export type TransportErrorCode = z.infer<typeof TransportErrorCode>;

export const TransportErrorInfo = z.strictObject({
  code: TransportErrorCode,
  retryable: z.boolean(),
  /** The provider's request id (x-typesafe-request-id for System One), when a response arrived. */
  requestId: z.string().nullable(),
});
export type TransportErrorInfo = z.infer<typeof TransportErrorInfo>;

const TRANSPORT_ERROR_BRAND = "bandwise.transport_error";

/**
 * What SystemOneTransport and LlmTransport throw. system-one-client maps SDK errors to the
 * system_one_* codes, llm-client maps provider errors to the llm_* codes, and both map an abort to
 * `client_aborted`. Core narrows with isTransportError, never with instanceof on a class from
 * another package, and never reads the message, which is already scrubbed of payloads.
 */
export class TransportError extends Error implements TransportErrorInfo {
  override readonly name = "TransportError";
  readonly brand = TRANSPORT_ERROR_BRAND;
  readonly code: TransportErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(info: TransportErrorInfo, message: string) {
    super(message);
    this.code = info.code;
    this.retryable = info.retryable;
    this.requestId = info.requestId;
  }
}

/** True for a TransportError, including one built by another copy of this module. */
export function isTransportError(e: unknown): e is TransportError {
  if (e instanceof TransportError) return true;
  if (typeof e !== "object" || e === null) return false;
  const candidate = e as { brand?: unknown; code?: unknown; retryable?: unknown; requestId?: unknown };
  return (
    candidate.brand === TRANSPORT_ERROR_BRAND &&
    TransportErrorInfo.safeParse({
      code: candidate.code,
      retryable: candidate.retryable,
      requestId: candidate.requestId,
    }).success
  );
}

// ---------------------------------------------------------------------------
// SystemOneTransport

/** Configures the SDK's own retries. It is not a second retry loop. */
export const RetryBudget = z.strictObject({
  maxRetries: z.number().int().nonnegative(),
  maxRetryAfterMs: z.number().int().nonnegative(),
});
export type RetryBudget = z.infer<typeof RetryBudget>;

export interface SystemOneCallOptions {
  /** Picks the SDK baseURL (SYSTEM_ONE_PROVIDER_BASE_URLS). Must match the key's provider. */
  provider: SystemOneProvider;
  apiKey: string;
  signal: AbortSignal;
  /** Per attempt. */
  timeoutMs: number;
  retry: RetryBudget;
}

export const SystemOneCallResult = z.strictObject({
  response: SystemOneResponse,
  /** The x-typesafe-request-id header, else the response `id` (OpenRouter's generation id). */
  requestId: z.string().nullable(),
});
export type SystemOneCallResult = z.infer<typeof SystemOneCallResult>;

/** One System One request. Throws a TransportError with a system_one_* code or client_aborted. */
export interface SystemOneTransport {
  call(req: SystemOneRequest, opts: SystemOneCallOptions): Promise<SystemOneCallResult>;
}

// ---------------------------------------------------------------------------
// ModelCatalog

export const EffectiveModel = z.strictObject({
  /** For a moving name, the profile of its last observed resolved model. */
  profile: ModelProfile.nullable(),
  /**
   * True only for a registry row of kind "versioned" and, on a provider other than typesafe, a
   * route row with `pinned`.
   */
  pinned: z.boolean(),
  resolvedId: z.string().nullable(),
  provider: SystemOneProvider,
  /** The id sent on this provider (resolveRoute). Null when the provider has no route for the name. */
  providerModelId: z.string().min(1).nullable(),
  /** Profile limits tightened by the route's (effectiveLimits). Preflight reads these. */
  limits: ModelLimits.nullable(),
});
export type EffectiveModel = z.infer<typeof EffectiveModel>;

/** id to ModelProfile. Whether a name is pinned comes from the registry, never a pattern match. */
export interface ModelCatalog {
  get(id: string): Promise<ModelProfile | null>;
  /** The profile, pinning, id to send and limits for a name on one provider. */
  effective(name: string, provider: SystemOneProvider): Promise<EffectiveModel>;
  /** Route rows for a provider, for registryIdForResolved. Empty for typesafe. */
  routes(provider: SystemOneProvider): Promise<ModelRoute[]>;
}

// ---------------------------------------------------------------------------
// KeyResolver

/**
 * The org's System One key for one provider. Only tenancy decrypts
 * it; it never leaves the server.
 */
export const ResolvedKey = z.strictObject({
  apiKey: z.string().min(1),
  mode: KeyMode,
  /** Always the provider that was asked for. A TypeSafe key is never sent to OpenRouter or back. */
  provider: SystemOneProvider,
});
export type ResolvedKey = z.infer<typeof ResolvedKey>;

/** Throws a TransportError with system_one_auth when the org has no usable key for the provider. */
export type KeyResolver = (ctx: TenantContext, provider: SystemOneProvider) => Promise<ResolvedKey>;

// ---------------------------------------------------------------------------
// RateLimiter and QuotaGuard

export const RateLimitBucket = z.enum(["run", "eval"]);
export type RateLimitBucket = z.infer<typeof RateLimitBucket>;

export const RateLimitReason = z.enum(["org", "key", "global", "eval"]);
export type RateLimitReason = z.infer<typeof RateLimitReason>;

export const RateLimitResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    retryAfterMs: z.number().int().nonnegative(),
    reason: RateLimitReason,
  }),
]);
export type RateLimitResult = z.infer<typeof RateLimitResult>;

/** Per-org, per-key and global limiters, keyed by model. */
export type RateLimiter = (
  ctx: TenantContext,
  model: string,
  estTokens: number,
  bucket: RateLimitBucket,
) => Promise<RateLimitResult>;

export const QuotaFailureCode = z.enum(["quota_exceeded", "token_budget_exceeded"]);
export type QuotaFailureCode = z.infer<typeof QuotaFailureCode>;

export const QuotaResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: QuotaFailureCode }),
]);
export type QuotaResult = z.infer<typeof QuotaResult>;

/** Plan quota and the agent token's daily spend cap. */
export type QuotaGuard = (ctx: TenantContext, model: string, estTokens: number) => Promise<QuotaResult>;

// ---------------------------------------------------------------------------
// RunSink

/**
 * Per-stage totals over a stage's calls: the input for usage_events and the per-stage latency
 * report. `runs.stages` stores `result.stages` (RunStage, with its calls), not these rows.
 */
export const RunSinkStage = z.strictObject({
  id: z.string().min(1),
  skipped: z.boolean(),
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  latencyMs: z.number().int().nonnegative(),
  typesafeRequestId: z.string().nullable(),
});
export type RunSinkStage = z.infer<typeof RunSinkStage>;

export const RunSinkRecord = z
  .strictObject({
    result: RunResult,
    /** externalRef, source, metadata. */
    request: RunRequest,
    /** As stored: redacted per pii_mode, null for hash_only sets. */
    state: z.unknown().nullable(),
    stateHash: z.string().min(1),
    /** Totals derived from result.stages, one per spec stage in the same order. */
    stages: z.array(RunSinkStage),
    /** runs.key_mode, from the KeyResolver call the run already made. runs.error_code is result.error?.code. */
    keyMode: KeyMode,
    /** runs.system_one_provider: the provider every call of this run used (RunSettings.systemOneProvider). */
    provider: SystemOneProvider,
    /** runs.parent_run_id: set on a linked run started by a `set` fallback. */
    parentRunId: RunId.nullable(),
  })
  .superRefine((r, ctx) => {
    const expected = r.result.stages;
    if (r.stages.length !== expected.length) {
      ctx.addIssue({ code: "custom", path: ["stages"], message: "needs one row per result stage" });
      return;
    }
    for (const [i, row] of r.stages.entries()) {
      const stage = expected[i];
      if (stage === undefined) continue;
      const input = stage.calls.reduce((n, c) => n + c.inputTokens, 0);
      const output = stage.calls.reduce((n, c) => n + c.outputTokens, 0);
      if (row.id !== stage.id || row.skipped !== stage.skipped || row.inputTokens !== input || row.outputTokens !== output) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", i],
          message: "must match the id, skipped flag and token totals of result.stages at the same index",
        });
      }
    }
  });
export type RunSinkRecord = z.infer<typeof RunSinkRecord>;

export const RunSinkResult = z.strictObject({
  reviewItemIds: z.array(ReviewItemId),
  labelItemIds: z.array(ReviewItemId),
});
export type RunSinkResult = z.infer<typeof RunSinkResult>;

/**
 * One transaction: the run row, action review items, label items, usage events and the
 * model_alias_observations update. The implementation picks label items itself by calling
 * core/learning selectForLabeling with its day counters and an injected rand.
 */
export interface RunSink {
  persist(ctx: TenantContext, record: RunSinkRecord): Promise<RunSinkResult>;
}

// ---------------------------------------------------------------------------
// ActionRegistry

export const ActionJob = z.strictObject({
  runId: RunId,
  decisionId: DecisionId,
  handlerId: z.string().min(1),
  config: z.unknown(),
});
export type ActionJob = z.infer<typeof ActionJob>;

/** Plugin action handlers. */
export interface ActionRegistry {
  isEnabled(orgId: string, handlerId: string): Promise<boolean>;
  /** Idempotent by runId:decisionId; dispatched after commit. */
  enqueue(job: ActionJob): Promise<void>;
}

// ---------------------------------------------------------------------------
// PriceBook

/** Integer micro-USD per million tokens. */
export const ModelPrice = z.strictObject({
  inputPerMtokMicroUsd: MicroUsdPerMtok,
  outputPerMtokMicroUsd: MicroUsdPerMtok,
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * System One and comparator prices by exact model id. The org row first, then the platform
 * default. System One runs are priced by model_resolved, one call at a time, mapped to a registry
 * id with registryIdForResolved. A provider-reported `usage.cost` wins over the price book.
 * With `provider`, a row for that provider wins over a provider-independent row.
 */
export interface PriceBook {
  get(orgId: string, modelId: string, provider?: SystemOneProvider): Promise<ModelPrice | null>;
}

// ---------------------------------------------------------------------------
// LlmTransport

export const LlmCompletionRequest = z.strictObject({
  model: z.string().min(1),
  system: z.string(),
  prompt: z.string(),
  maxOutputTokens: z.number().int().positive(),
});
export type LlmCompletionRequest = z.infer<typeof LlmCompletionRequest>;

export const LlmCompletion = z.strictObject({
  text: z.string(),
  model: z.string().min(1),
  inputTokens: TokenCount,
  outputTokens: TokenCount,
});
export type LlmCompletion = z.infer<typeof LlmCompletion>;

/**
 * Used by escalate_to_llm, Studio drafting, improve mode and opportunity drafting. Throws a
 * TransportError with an llm_* code or client_aborted.
 */
export interface LlmTransport {
  complete(req: LlmCompletionRequest & { signal: AbortSignal }): Promise<LlmCompletion>;
}

// ---------------------------------------------------------------------------
// Redactor

/** Pure: returns a redacted copy of state. */
export type Redactor = (state: unknown, paths: string[], piiMode: PiiMode) => unknown;

// ---------------------------------------------------------------------------
// RunPorts and runQuestionSet

/** Epoch ms. latencyMs and timestamps come from here, never Date.now(). */
export type Clock = () => EpochMs;

/** uuidv7 for runId. Tests inject a fixed sequence. */
export type IdSource = () => string;

export interface RunPorts {
  /** One System One request. */
  systemOne: SystemOneTransport;
  /** id to ModelProfile; resolves a moving name to its last observed versioned model. */
  models: ModelCatalog;
  /** The org's System One key, key mode and provider. */
  keys: KeyResolver;
  /** Per-org, per-key and global limiters, keyed by model. */
  limiter: RateLimiter;
  /** Plan quota and the agent token's daily spend cap. */
  quota: QuotaGuard;
  /** Persist run, review items, label items, usage events in one transaction. */
  runs: RunSink;
  /** Plugin action handlers. */
  actions: ActionRegistry;
  /** System One and comparator prices by exact model id. */
  prices: PriceBook;
  clock: Clock;
  newId: IdSource;
  /** escalate_to_llm. */
  llm?: LlmTransport;
  redactor?: Redactor;
  /** `set` fallbacks. Missing: the decision keeps its value and the run gets `fallback_set_failed`. */
  linkedRun?: LinkedRunPort;
}

// ---------------------------------------------------------------------------
// Linked runs

export interface LinkedRunOptions {
  /** The caller's channel, so the linked set's own pointer and rollout stage on it apply. */
  channel: PointerChannel;
  parentRunId: RunId;
  /** Fires when the parent's remaining latency budget runs out. */
  signal: AbortSignal;
}

/**
 * Runs another set on the caller's original state as a linked run, before the parent run is
 * persisted. The linked run is persisted with `runs.parent_run_id` set; the parent's decision gets
 * `fallbackRunId`.
 */
export type LinkedRunPort = (setRef: string, state: unknown, opts: LinkedRunOptions) => Promise<RunResult>;

// ---------------------------------------------------------------------------
// Latency budgets

/** The surfaces with a latency budget. */
export const RunSurface = z.enum(["api", "embed", "extension", "eval"]);
export type RunSurface = z.infer<typeof RunSurface>;

/** Total budget per run, in ms. Every System One call's timeout and retry budget come from what is left. */
export const LATENCY_BUDGET_MS = {
  api: 8_000,
  embed: 5_000,
  extension: 3_000,
  eval: 30_000,
} as const satisfies Record<RunSurface, number>;

/** Which budget a run source uses. Console, playground, CLI and MCP runs go through the API budget. */
export const RUN_SOURCE_SURFACE = {
  console: "api",
  playground: "api",
  api: "api",
  embed: "embed",
  extension: "extension",
  mcp: "api",
  eval: "eval",
  cli: "api",
} as const satisfies Record<RunSource, RunSurface>;

/** The latency budget for a run source. */
export function latencyBudgetMs(source: RunSource): number {
  return LATENCY_BUDGET_MS[RUN_SOURCE_SURFACE[source]];
}

// ---------------------------------------------------------------------------
// runQuestionSet

/**
 * Set and org settings the router and the envelope builder read. The resolver reads them with the
 * pointer; core never reads a store.
 */
export const RunSettings = z.strictObject({
  /** question_sets.dispatch_actions_on_staging. Without it, auto on staging is not executed. */
  dispatchActionsOnStaging: z.boolean(),
  /** question_sets.storage_mode. hash_only: RunSinkRecord.state is null. */
  storageMode: StorageMode,
  /** organizations.pii_mode, passed to the Redactor. */
  piiMode: PiiMode,
  /**
   * The org's default comparator: RunCost.comparatorModel when spec.savings.comparatorModel is
   * absent, and the EscalationConfig.model default.
   */
  defaultComparatorModel: z.string().min(1),
  /**
   * Mean cost of the org's actual escalations, for escalation_avoided savings.
   * Null when the org has none; core then estimates it with the comparator.
   */
  avgEscalationCostMicroUsd: MicroUsd.nullable(),
  /**
   * Who serves this run's System One calls: question_sets.system_one_provider when set, else
   * organizations.default_system_one_provider. Core passes it to KeyResolver,
   * ModelCatalog.effective and every SystemOneTransport call.
   */
  systemOneProvider: SystemOneProvider,
});
export type RunSettings = z.infer<typeof RunSettings>;

/** What the pointer resolver hands to runQuestionSet. */
export const ResolvedRun = z.strictObject({
  spec: QuestionSetSpec,
  setId: SetId,
  /** The version number; the draft row's number for slug@draft. */
  version: z.number().int().positive(),
  versionId: VersionId,
  interfaceMajor: z.number().int().nonnegative(),
  interfaceHash: z.string().min(1),
  channel: Channel,
  rollout: RolloutStage,
  experiment: z.strictObject({ id: ExperimentId, arm: ExperimentArm }).optional(),
  settings: RunSettings,
});
export type ResolvedRun = z.infer<typeof ResolvedRun>;

/** Cancellation and the latency budget for one run. */
export interface RunControl {
  /** Fires when the caller goes away (client disconnect) or the budget runs out. */
  signal: AbortSignal;
  /** Total budget in ms, usually latencyBudgetMs(req.source). Core measures it with ports.clock. */
  budgetMs: number;
}

/**
 * Runs one question set. Returns a RunResult for every run that got a runId, including failed ones
 * (status other than "ok", with `error`). Throws only before a run row exists, for example on
 * invalid state or an inactive channel.
 */
export type RunQuestionSet = (
  ctx: TenantContext,
  req: RunRequest,
  resolved: ResolvedRun,
  ports: RunPorts,
  control: RunControl,
) => Promise<RunResult>;
