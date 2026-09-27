// Conditions, checks, confidence policies and actions.
// Every schema here is part of the strict spec, so unknown
// keys fail. Free-form values stay open: the handler `config` on an `auto` action (section 13).
//
// Condition and Check live here rather than in spec.ts because policies (`relevantWhen`) need them
// and spec.ts imports policies. Keeping the import graph acyclic avoids module init order bugs.

import { z } from "zod";
import { Band, DecisionId, QuestionId, StatePath, Structured, Value } from "./common.js";

// ---------------------------------------------------------------------------
// Condition

interface Range {
  gte?: number;
  lte?: number;
}

/**
 * One safe grammar for stage `when`, `relevantWhen`, routes and checks. Data only: no functions and
 * no expressions. Which leaves each place may read is a lint concern, not a schema concern.
 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { q: QuestionId; eq: Value }
  | { q: QuestionId; neq: Value }
  | { q: QuestionId; in: Value[] }
  | { q: QuestionId; band: Band }
  | ({ q: QuestionId } & Range)
  | ({ composite: DecisionId } & Range)
  | { check: DecisionId }
  | { input: StatePath; eq: Value }
  | { input: StatePath; neq: Value }
  | { input: StatePath; in: Value[] }
  | { input: StatePath; exists: boolean }
  | { input: StatePath; matches: string }
  | ({ input: StatePath } & Range);

/** Max length of a `matches` regular expression. It runs on a linear-time engine. */
export const CONDITION_MATCHES_MAX_LENGTH = 256;

/**
 * Why a `matches` pattern falls outside the linear-time subset, or null when it is inside.
 *
 * The subset is JavaScript regular expression syntax with the `u` flag, minus the features no
 * linear-time (automaton) engine can run: backreferences (`\1`, `\k<name>`) and lookaround
 * (`(?=`, `(?!`, `(?<=`, `(?<!`). Core matches this subset with its own pure automaton, so
 * JavaScript's backtracking RegExp never runs untrusted patterns on state.
 */
export function matchesPatternProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, "u");
  } catch {
    return "not a valid regular expression (u flag)";
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || next === "k")) return "backreferences are not supported";
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const rest = pattern.slice(i + 2, i + 4);
      if (rest.startsWith("=") || rest.startsWith("!") || rest === "<=" || rest === "<!") {
        return "lookahead and lookbehind are not supported";
      }
    }
  }
  return null;
}

const MatchesPattern = z
  .string()
  .min(1)
  .max(CONDITION_MATCHES_MAX_LENGTH)
  .superRefine((pattern, ctx) => {
    const problem = matchesPatternProblem(pattern);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `matches: ${problem}` });
  });

const hasBound = (r: Range): boolean => r.gte !== undefined || r.lte !== undefined;
const RANGE_MESSAGE = "a range condition needs gte, lte or both";

const bound = z.number().optional();
const qRange = z.strictObject({ q: QuestionId, gte: bound, lte: bound }).refine(hasBound, RANGE_MESSAGE);
const compositeRange = z
  .strictObject({ composite: DecisionId, gte: bound, lte: bound })
  .refine(hasBound, RANGE_MESSAGE);
const inputRange = z
  .strictObject({ input: StatePath, gte: bound, lte: bound })
  .refine(hasBound, RANGE_MESSAGE);

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(Condition) }),
    z.strictObject({ any: z.array(Condition) }),
    z.strictObject({ not: Condition }),
    z.strictObject({ q: QuestionId, eq: Value }),
    z.strictObject({ q: QuestionId, neq: Value }),
    z.strictObject({ q: QuestionId, in: z.array(Value) }),
    z.strictObject({ q: QuestionId, band: Band }),
    qRange,
    compositeRange,
    z.strictObject({ check: DecisionId }),
    z.strictObject({ input: StatePath, eq: Value }),
    z.strictObject({ input: StatePath, neq: Value }),
    z.strictObject({ input: StatePath, in: z.array(Value) }),
    z.strictObject({ input: StatePath, exists: z.boolean() }),
    z.strictObject({ input: StatePath, matches: MatchesPattern }),
    inputRange,
  ]),
);

// ---------------------------------------------------------------------------
// Check

/** A code condition evaluated in core before any System One call. `when` reads input only. */
export const Check = z.strictObject({
  id: DecisionId,
  when: Condition,
});
export type Check = z.infer<typeof Check>;

// ---------------------------------------------------------------------------
// Fallback and escalation config

/** `ActionRef.config` when `kind` is `fallback`. Omitted config means `noop`. */
export const FallbackConfig = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), value: Value }),
  z.strictObject({ kind: z.literal("set"), setRef: z.string().min(1) }),
  z.strictObject({ kind: z.literal("noop") }),
]);
export type FallbackConfig = z.infer<typeof FallbackConfig>;

/** Default `EscalationConfig.maxOutputTokens`. */
export const ESCALATION_DEFAULT_MAX_OUTPUT_TOKENS = 256;

/** `ActionRef.config` when `kind` is `escalate_to_llm`. */
export const EscalationConfig = z.strictObject({
  /** Exact comparator model id with a price_books row. Default: spec.savings.comparatorModel, else the org default. */
  model: z.string().min(1).optional(),
  /** Added after the question's own instructions. */
  instructions: Structured.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type EscalationConfig = z.infer<typeof EscalationConfig>;

// ---------------------------------------------------------------------------
// ActionRef

/** A globally unique handler id `<namespace>.<name>`, for example `builtin.slack.notify`. */
export const HandlerId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/, "handler ids look like <namespace>.<name>");
export type HandlerId = z.infer<typeof HandlerId>;

const AutoActionRef = z.strictObject({
  kind: z.literal("auto"),
  handler: HandlerId.optional(),
  /** Handler config, free-form. */
  config: z.unknown().optional(),
});
/**
 * No config: handler config applies only to an auto action, since handlers run only when
 * effectiveAction is auto. A review `config` fails as an
 * unknown key.
 */
const ReviewActionRef = z.strictObject({
  kind: z.literal("review"),
  handler: HandlerId.optional(),
});
const FallbackActionRef = z.strictObject({
  kind: z.literal("fallback"),
  handler: HandlerId.optional(),
  config: FallbackConfig.optional(),
});
const EscalateActionRef = z.strictObject({
  kind: z.literal("escalate_to_llm"),
  handler: HandlerId.optional(),
  config: EscalationConfig.optional(),
});

/** What a band (or a composite level) maps to. `config` is typed per `kind`. */
export const ActionRef = z.discriminatedUnion("kind", [
  AutoActionRef,
  ReviewActionRef,
  FallbackActionRef,
  EscalateActionRef,
]);
export type ActionRef = z.infer<typeof ActionRef>;

/** A composite policy cannot escalate: a composite has no answer type for the LLM to return. */
export const CompositeActionRef = z.discriminatedUnion("kind", [
  AutoActionRef,
  ReviewActionRef,
  FallbackActionRef,
]);
export type CompositeActionRef = z.infer<typeof CompositeActionRef>;

export const BandActions = z.strictObject({
  high: ActionRef,
  medium: ActionRef,
  low: ActionRef,
});
export type BandActions = z.infer<typeof BandActions>;

/** Actions keyed by composite level (magnitude), not band. */
export const CompositeBandActions = z.strictObject({
  high: CompositeActionRef,
  medium: CompositeActionRef,
  low: CompositeActionRef,
});
export type CompositeBandActions = z.infer<typeof CompositeBandActions>;

// ---------------------------------------------------------------------------
// ConfidencePolicy

const unit = z.number().min(0).max(1);

/** Choice and score: applied to `confidence`. Composite: applied to the 0 to 1 value. Order is lint `policy.thresholds_order`. */
export const Thresholds = z.strictObject({ high: unit, medium: unit });
export type Thresholds = z.infer<typeof Thresholds>;

/** Noul settings. Their order is lint `policy.noul_order`. */
export const NoulThresholds = z.strictObject({ trueAt: unit, falseAt: unit, reviewMargin: unit });
export type NoulThresholds = z.infer<typeof NoulThresholds>;

export const NoulPolicy = z.strictObject({
  type: z.literal("noul"),
  gating: z.boolean(),
  relevantWhen: Condition.optional(),
  noul: NoulThresholds,
  actions: BandActions,
});
export type NoulPolicy = z.infer<typeof NoulPolicy>;

export const ChoicePolicy = z.strictObject({
  type: z.literal("choice"),
  gating: z.boolean(),
  relevantWhen: Condition.optional(),
  thresholds: Thresholds,
  /** Stricter bars for risky options. Keys must be option keys (lint `policy.per_option_keys`). */
  perOption: z.record(z.string().min(1), Thresholds).optional(),
  actions: BandActions,
});
export type ChoicePolicy = z.infer<typeof ChoicePolicy>;

export const ScorePolicy = z.strictObject({
  type: z.literal("score"),
  gating: z.boolean(),
  relevantWhen: Condition.optional(),
  thresholds: Thresholds,
  actions: BandActions,
});
export type ScorePolicy = z.infer<typeof ScorePolicy>;

export const CompositePolicy = z.strictObject({
  type: z.literal("composite"),
  gating: z.boolean(),
  levelThresholds: Thresholds,
  actions: CompositeBandActions,
});
export type CompositePolicy = z.infer<typeof CompositePolicy>;

export const ConfidencePolicy = z.discriminatedUnion("type", [
  NoulPolicy,
  ChoicePolicy,
  ScorePolicy,
  CompositePolicy,
]);
export type ConfidencePolicy = z.infer<typeof ConfidencePolicy>;

/** The policy variant a question type uses. */
export type QuestionPolicy = NoulPolicy | ChoicePolicy | ScorePolicy;
