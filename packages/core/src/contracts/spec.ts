// QuestionSetSpec, the strict spec schema, parseSpec, SetInterface and the run request contracts.
//
// The spec is strict: unknown keys fail, including `rollout`, which is set per channel through the
// `rollout.change` operation. Free-form values stay open: instructions, criteria, question meta,
// input.schema, adapter config and handler config.

import { z } from "zod";
import {
  DecisionId,
  JsonObject,
  PointerChannel,
  QuestionId,
  SavingsKind,
  SetId,
  StatePath,
  TokenCount,
  VersionId,
} from "./common.js";
import { Check, CompositePolicy, ConfidencePolicy, Condition } from "./policy.js";
import { QuestionDef, QuestionTypeId } from "./question-types.js";
import { SystemOneProvider, SystemOneRequest } from "./system-one.js";

// ---------------------------------------------------------------------------
// Spec parts

/** The only schemaVersion frozen so far. A breaking change bumps it and ships a pure migrateSpec. */
export const SPEC_SCHEMA_VERSION = 1;

/** Top-level state key that merged stages use for earlier answers. input.schema cannot declare it. */
export const RESERVED_STATE_KEY = "answers";

export const InputAdapter = z.strictObject({
  id: z.string().min(1),
  /** Free-form adapter config. */
  config: z.unknown(),
});
export type InputAdapter = z.infer<typeof InputAdapter>;

export const SpecInput = z.strictObject({
  /** JSON Schema draft 7 that validates incoming state. Free-form. */
  schema: JsonObject,
  adapter: InputAdapter.optional(),
  /** Each must resolve in input.schema (lint `redact.path_unknown`). */
  redactPaths: z.array(StatePath).optional(),
  maxStateTokens: z.number().int().positive().optional(),
});
export type SpecInput = z.infer<typeof SpecInput>;

/** Earlier answers land under `answers.<qid>` as `{ value, band }`, plus probabilities or noul on request. */
export const StateMerge = z.strictObject({
  input: z.literal(true),
  answers: z.array(QuestionId),
  probabilities: z.boolean().optional(),
});
export type StateMerge = z.infer<typeof StateMerge>;

export const StateFrom = z.union([z.literal("input"), z.strictObject({ merge: StateMerge })]);
export type StateFrom = z.infer<typeof StateFrom>;

/** A spec stage: one System One call. Not a rollout stage. */
export const SpecStage = z.strictObject({
  id: z.string().min(1),
  when: Condition.optional(),
  stateFrom: StateFrom.optional(),
  questions: z
    .record(QuestionId, QuestionDef)
    .refine((q) => Object.keys(q).length > 0, "a stage needs at least one question"),
});
export type SpecStage = z.infer<typeof SpecStage>;

const weight = z.number().positive();

/** A question term. `option` is required for a choice and names the option whose probability counts. */
export const QuestionCompositeTerm = z.strictObject({
  q: QuestionId,
  weight,
  option: z.string().min(1).optional(),
});
export type QuestionCompositeTerm = z.infer<typeof QuestionCompositeTerm>;

/** A check term: 1 when the check held, else 0. Counts as band high. */
export const CheckCompositeTerm = z.strictObject({
  check: DecisionId,
  weight,
});
export type CheckCompositeTerm = z.infer<typeof CheckCompositeTerm>;

export const CompositeTerm = z.union([QuestionCompositeTerm, CheckCompositeTerm]);
export type CompositeTerm = z.infer<typeof CompositeTerm>;

/**
 * Value is sum(weight x termValue) / sum(weight) over the terms that apply. Level (magnitude) comes from
 * levelThresholds and picks the action; band (certainty) is the minimum band of its question terms.
 */
export const Composite = z.strictObject({
  id: DecisionId,
  kind: z.literal("weighted"),
  terms: z.array(CompositeTerm).min(1),
  /** Optional. Without one the composite never gates and only routes use it. */
  policy: CompositePolicy.optional(),
});
export type Composite = z.infer<typeof Composite>;

/** Checked in order; the first match wins. */
export const Route = z.strictObject({
  when: Condition,
  output: z.string().min(1),
});
export type Route = z.infer<typeof Route>;

export const SpecSavings = z.strictObject({
  comparatorModel: z.string().min(1).optional(),
  estOutputTokensPerQuestion: z.number().int().nonnegative().optional(),
  kind: SavingsKind.optional(),
});
export type SpecSavings = z.infer<typeof SpecSavings>;

// ---------------------------------------------------------------------------
// Outage rule

/** What a gating decision does when System One is unavailable after retries. Never `auto`. */
export const ON_UNAVAILABLE_ACTIONS = ["fallback", "review", "escalate_to_llm"] as const;
export const OnUnavailable = z.enum(ON_UNAVAILABLE_ACTIONS);
export type OnUnavailable = z.infer<typeof OnUnavailable>;

/**
 * The outage rule when a spec leaves `onUnavailable` out. `review`: an
 * outage becomes work for a person, never a decision dropped where nobody looks.
 */
export const DEFAULT_ON_UNAVAILABLE: OnUnavailable = "review";

/** Rule id when anything maps `onUnavailable` to `auto`. */
export const OUTAGE_AUTO_NOT_ALLOWED_RULE = "outage.auto_not_allowed";
export const OUTAGE_AUTO_NOT_ALLOWED_MESSAGE =
  "onUnavailable cannot be auto: an outage gives no answer to act on; use fallback, review or escalate_to_llm";

/** The spec's outage rule, with the default applied. */
export function onUnavailableOf(spec: Pick<QuestionSetSpec, "onUnavailable">): OnUnavailable {
  return spec.onUnavailable ?? DEFAULT_ON_UNAVAILABLE;
}

// ---------------------------------------------------------------------------
// QuestionSetSpec

/** Rule id for a key the strict spec schema does not know. */
export const SPEC_UNKNOWN_KEY_RULE = "spec.unknown_key";
/** Rule id for any other schema failure. */
export const SPEC_INVALID_RULE = "spec.invalid";
/** Rule id for a question, composite or check id used twice, or a repeated stage id. */
export const SPEC_DUPLICATE_ID_RULE = "spec.duplicate_id";

export const ROLLOUT_KEY_MESSAGE = "rollout is set per channel; use rollout.change";

const QuestionSetSpecShape = z.strictObject({
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  /** A versioned registry id (pinned) or a moving name such as jev-latest. The registry decides which. */
  model: z.string().min(1),
  input: SpecInput,
  checks: z.array(Check).optional(),
  stages: z.array(SpecStage).min(1),
  policies: z.record(QuestionId, ConfidencePolicy),
  composites: z.array(Composite).optional(),
  routes: z.array(Route).optional(),
  defaultRoute: z.string().min(1).optional(),
  savings: SpecSavings.optional(),
  /**
   * The outage rule: every gating decision's effectiveAction when System One is
   * unavailable after retries. Default `review`. `auto` is not allowed
   * (`outage.auto_not_allowed`).
   */
  onUnavailable: OnUnavailable.optional(),
});

export const QuestionSetSpec = QuestionSetSpecShape.superRefine((spec, ctx) => {
  const duplicate = (path: (string | number)[], message: string) => {
    ctx.addIssue({ code: "custom", path, message, params: { rule: SPEC_DUPLICATE_ID_RULE } });
  };

  const stageIds = new Set<string>();
  spec.stages.forEach((stage, i) => {
    if (stageIds.has(stage.id)) duplicate(["stages", i, "id"], `stage id "${stage.id}" is used twice`);
    stageIds.add(stage.id);
  });

  // Questions, composites and checks share one DecisionId namespace.
  const decisionIds = new Set<string>();
  spec.stages.forEach((stage, i) => {
    for (const qid of Object.keys(stage.questions)) {
      if (decisionIds.has(qid)) duplicate(["stages", i, "questions", qid], `id "${qid}" is used twice`);
      decisionIds.add(qid);
    }
  });
  spec.composites?.forEach((c, i) => {
    if (decisionIds.has(c.id)) duplicate(["composites", i, "id"], `id "${c.id}" is used twice`);
    decisionIds.add(c.id);
  });
  spec.checks?.forEach((c, i) => {
    if (decisionIds.has(c.id)) duplicate(["checks", i, "id"], `id "${c.id}" is used twice`);
    decisionIds.add(c.id);
  });
});
export type QuestionSetSpec = z.infer<typeof QuestionSetSpec>;

/** Every question in the spec, in stage order, with its stage index. */
export function specQuestions(
  spec: QuestionSetSpec,
): Array<{ id: QuestionId; stageIndex: number; question: QuestionDef }> {
  return spec.stages.flatMap((stage, stageIndex) =>
    Object.entries(stage.questions).map(([id, question]) => ({ id, stageIndex, question })),
  );
}

// ---------------------------------------------------------------------------
// LintResult and parseSpec

export const LintSeverity = z.enum(["error", "warning"]);
export type LintSeverity = z.infer<typeof LintSeverity>;

/**
 * One lint or spec validation finding. The same shape as one item of
 * `error.details` in the error envelope, so `draft/validate` and `422 spec_invalid` return it as is.
 */
export const LintResult = z.strictObject({
  /** Stable rule id, for example `spec.unknown_key` or `model.alias_past_shadow`. Never renamed. */
  rule: z.string().min(1),
  severity: LintSeverity,
  /** JSON Pointer into the spec. */
  path: z.string(),
  message: z.string(),
});
export type LintResult = z.infer<typeof LintResult>;

/** RFC 6901 JSON Pointer for a zod issue path. The root is the empty string. */
export function toJsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((seg) => "/" + String(seg).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("");
}

function ruleOf(issue: z.core.$ZodIssue): string {
  if (issue.code === "custom") {
    const rule: unknown = issue.params?.["rule"];
    if (typeof rule === "string") return rule;
  }
  return SPEC_INVALID_RULE;
}

/** Map zod issues from the spec schema to `error.details` items. */
export function specIssuesToDetails(issues: readonly z.core.$ZodIssue[]): LintResult[] {
  const details: LintResult[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = toJsonPointer([...issue.path, key]);
        details.push({
          path,
          rule: SPEC_UNKNOWN_KEY_RULE,
          severity: "error",
          message: path === "/rollout" ? ROLLOUT_KEY_MESSAGE : `unknown key "${key}"`,
        });
      }
      continue;
    }
    details.push({
      path: toJsonPointer(issue.path),
      rule: ruleOf(issue),
      severity: "error",
      message: issue.message,
    });
  }
  return details;
}

export type ParseSpecResult =
  | { ok: true; spec: QuestionSetSpec }
  | { ok: false; details: LintResult[] };

/**
 * Parse a spec with the strict schema. Failures come back as error-envelope details with stable rule
 * ids: `spec.unknown_key` at the JSON Pointer of the stray key, `spec.duplicate_id`, or `spec.invalid`.
 */
export function parseSpec(input: unknown): ParseSpecResult {
  const result = QuestionSetSpec.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  const details = specIssuesToDetails(result.error.issues);
  // An outage rule of `auto` gets its own rule id, so the message says why it is refused.
  if (typeof input === "object" && input !== null && (input as { onUnavailable?: unknown }).onUnavailable === "auto") {
    for (const d of details) {
      if (d.path === "/onUnavailable") {
        d.rule = OUTAGE_AUTO_NOT_ALLOWED_RULE;
        d.message = OUTAGE_AUTO_NOT_ALLOWED_MESSAGE;
      }
    }
  }
  return { ok: false, details };
}


// ---------------------------------------------------------------------------
// SetInterface

export const InterfaceQuestion = z.strictObject({
  id: QuestionId,
  type: QuestionTypeId,
  /** Choice option keys. */
  options: z.array(z.string()).optional(),
  /** Score level count. */
  levels: z.number().int().positive().optional(),
});
export type InterfaceQuestion = z.infer<typeof InterfaceQuestion>;

/** What app code depends on. Versions store its hash and interfaceMajor. */
export const SetInterface = z.strictObject({
  inputSchema: JsonObject,
  questions: z.array(InterfaceQuestion),
  /** Composite ids. */
  composites: z.array(DecisionId),
  /** Every route output, plus defaultRoute. */
  routeOutputs: z.array(z.string()),
});
export type SetInterface = z.infer<typeof SetInterface>;

/** The result of diffInterface(a, b). Items are human-readable, for example "question added: work_type". */
export const InterfaceDiff = z.strictObject({
  breaking: z.array(z.string()),
  additive: z.array(z.string()),
});
export type InterfaceDiff = z.infer<typeof InterfaceDiff>;

// ---------------------------------------------------------------------------
// RunRequest

/** Set by the adapter from the auth mode, never read from the body. runs.source also has "ingest". */
export const RunSource = z.enum(["console", "playground", "api", "embed", "extension", "mcp", "eval", "cli"]);
export type RunSource = z.infer<typeof RunSource>;

export const RunOptions = z.strictObject({
  /** Shapes the response only; runs always store full answers. */
  includeProbabilities: z.boolean().optional(),
  /** Compile and preflight only: the run returns RunDryRunResult. */
  dryRun: z.boolean().optional(),
  /** The app's own id, used to match feedback later. */
  externalRef: z.string().min(1).optional(),
  /** For context_pruned savings. */
  metadata: z
    .strictObject({ tokensBefore: TokenCount.optional(), tokensAfter: TokenCount.optional() })
    .optional(),
});
export type RunOptions = z.infer<typeof RunOptions>;

/** What every run surface hands to runQuestionSet after auth and parsing. */
export const RunRequest = z.strictObject({
  /** Slug or set id. */
  setRef: z.string().min(1),
  /** Sessions and agent tokens only; app tokens use their bound channel. */
  channel: PointerChannel.optional(),
  /** slug@7 or slug@draft. */
  version: z.union([z.number().int().positive(), z.literal("draft")]).optional(),
  /** Validated against input.schema. */
  state: z.unknown(),
  source: RunSource,
  options: RunOptions,
  /** From the Idempotency-Key header. */
  idempotencyKey: z.string().min(1).optional(),
  /** From the Bandwise-Interface header. */
  interfaceMajor: z.number().int().nonnegative().optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

// ---------------------------------------------------------------------------
// RunDryRunResult

export const DryRunBatch = z.strictObject({
  /** The payload after redaction, exactly as it would be sent. */
  request: SystemOneRequest,
  estTokens: TokenCount,
});
export type DryRunBatch = z.infer<typeof DryRunBatch>;

export const DryRunStage = z.strictObject({
  id: z.string().min(1),
  /** Its `when` was false on input and checks. */
  skipped: z.boolean(),
  /** One per request after splitting. */
  batches: z.array(DryRunBatch),
});
export type DryRunStage = z.infer<typeof DryRunStage>;

/**
 * `options.dryRun` stops after preflight: no System One call, no run row, no usage, no limiter tokens.
 * The run response is `RunResult | RunDryRunResult`, told apart by `dryRun === true`.
 */
export const RunDryRunResult = z.strictObject({
  dryRun: z.literal(true),
  setId: SetId,
  versionId: VersionId,
  version: z.union([z.number().int().positive(), z.literal("draft")]),
  /** The spec's model, as requested. */
  model: z.string().min(1),
  /** The ModelProfile preflight used; for a moving name, the profile of its last observed versioned model. */
  profileId: z.string().min(1),
  /** The provider the run would call (RunSettings.systemOneProvider). Batch requests carry its model id. */
  provider: SystemOneProvider,
  stages: z.array(DryRunStage),
  /** The effective limits on that provider: the profile's, tightened by the route's. */
  limits: z.strictObject({ requestTokens: TokenCount, statePlusLongestQuestionTokens: TokenCount }),
  /** Preflight warnings, and dry_run_answers_unknown. */
  warnings: z.array(z.string()),
});
export type RunDryRunResult = z.infer<typeof RunDryRunResult>;
