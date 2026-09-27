// The confidence router. It turns answers into
// decisions: value and band through each question-type module, relevance, composites (level and
// band), routes, and the effective action from the normative table in effective-action.ts. It
// also computes runBand and overallAction with the conservative order.

import type {
  Action,
  Band,
  Channel,
  ExperimentArm,
  RolloutStage,
  Value,
} from "../contracts/common.js";
import { BAND_ORDER, mostConservativeAction } from "../contracts/common.js";
import type {
  ActionRef,
  CompositeActionRef,
  EscalationConfig,
  FallbackConfig,
  QuestionPolicy,
  Thresholds,
} from "../contracts/policy.js";
import type { Decision, Level } from "../contracts/run.js";
import type { Composite, QuestionSetSpec } from "../contracts/spec.js";
import { onUnavailableOf } from "../contracts/spec.js";
import type { KnownAnswer, SystemOneAnswer } from "../contracts/system-one.js";
import type { QuestionTypeId } from "../contracts/question-types.js";
import { type ConditionContext, type QuestionView, evaluateCondition } from "../conditions/evaluate.js";
import { compositeTermValue, readAnswer } from "./answers.js";
import {
  effectiveAction,
  isExecuted,
  isOutageExecuted,
  isShadowLike,
  outageEffectiveAction,
  routingStage,
} from "./effective-action.js";

export interface RouterInput {
  spec: QuestionSetSpec;
  /** Raw answers of asked questions, as stored. */
  answers: Readonly<Record<string, SystemOneAnswer>>;
  /** Questions whose spec stage ran. A question outside this set was skipped. */
  asked: ReadonlySet<string>;
  checks: Readonly<Record<string, boolean>>;
  /** The validated input before redaction. */
  input: unknown;
  rollout: RolloutStage;
  channel: Channel;
  dispatchActionsOnStaging: boolean;
  arm?: ExperimentArm | undefined;
}

/** What the run needs to know about a decision beyond the envelope. */
export interface DecisionMeta {
  kind: "question" | "composite";
  /** Counts toward runBand as gating. */
  gating: boolean;
  /** False only for a composite with no policy: it never feeds runBand or overallAction. */
  counts: boolean;
  /** The policy action that picked this decision's action, when there is one. */
  actionRef: ActionRef | CompositeActionRef | null;
  /** The question type, for questions. */
  questionType: QuestionTypeId | null;
  /** The typed answer, for answered questions a module could read. */
  answer: KnownAnswer | null;
}

export interface RouterOutput {
  decisions: Record<string, Decision>;
  meta: Record<string, DecisionMeta>;
  /** Views of asked questions, as conditions read them. */
  views: Record<string, QuestionView>;
  /** Composite values by id; null when no term was left. */
  composites: Record<string, number | null>;
  runBand: Band;
  overallAction: Action;
  route: string | null;
  /** unknown_answer_type and the other answer warnings, once each, in first-seen order. */
  warnings: string[];
}

const minBand = (bands: readonly Band[]): Band =>
  bands.reduce<Band>((lo, b) => (BAND_ORDER.indexOf(b) > BAND_ORDER.indexOf(lo) ? b : lo), "high");

/** Level (magnitude) of a composite value. */
export function compositeLevel(value: number, t: Thresholds): Level {
  if (value >= t.high) return "high";
  if (value >= t.medium) return "medium";
  return "low";
}

/** The decision of a question in a skipped spec stage, or of a composite with no term left. */
function emptyDecision(kind: "question" | "composite"): Decision {
  return { kind, value: null, band: "low", relevant: false, action: "fallback", effectiveAction: "fallback", executed: false };
}

/**
 * runBand and overallAction over counted decisions. Relevant gating
 * decisions decide; with none, every relevant counted decision; with none at all, low and fallback.
 */
export function summarizeDecisions(
  decisions: Readonly<Record<string, Decision>>,
  meta: Readonly<Record<string, DecisionMeta>>,
): { runBand: Band; overallAction: Action } {
  const counted = Object.entries(decisions).filter(([id, d]) => d.relevant && meta[id]?.counts === true);
  const gating = counted.filter(([id]) => meta[id]?.gating === true);
  const pool = gating.length > 0 ? gating : counted;
  if (pool.length === 0) return { runBand: "low", overallAction: "fallback" };
  return {
    runBand: minBand(pool.map(([, d]) => d.band)),
    overallAction: mostConservativeAction(pool.map(([, d]) => d.effectiveAction)),
  };
}

/** The value a fallback policy action with a `value` config gives, when that fallback runs. */
function applyFallbackValue(value: Value, ref: ActionRef | CompositeActionRef, executed: boolean): Value {
  if (!executed || ref.kind !== "fallback" || ref.config?.kind !== "value") return value;
  return ref.config.value;
}

/** Route answers into decisions. Pure; never throws on answer data. */
export function routeAnswers(input: RouterInput): RouterOutput {
  const { spec } = input;
  const stage = routingStage(input.rollout, input.channel);
  const warnings: string[] = [];
  const warn = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const execution = { stage, channel: input.channel, dispatchActionsOnStaging: input.dispatchActionsOnStaging, arm: input.arm };

  // 1. Views of every asked question, so relevantWhen and routes can read any answer in the run.
  const views: Record<string, QuestionView> = {};
  const reads = new Map<string, ReturnType<typeof readAnswer>>();
  for (const s of spec.stages) {
    for (const [qid, q] of Object.entries(s.questions)) {
      if (!input.asked.has(qid)) continue;
      const read = readAnswer(q, spec.policies[qid], input.answers[qid]);
      reads.set(qid, read);
      views[qid] = read.view;
      if (!read.ok) warn(read.warning);
    }
  }
  const baseCtx: ConditionContext = { input: input.input, checks: input.checks, questions: views, composites: {} };

  // 2. Question decisions.
  const decisions: Record<string, Decision> = {};
  const meta: Record<string, DecisionMeta> = {};
  for (const s of spec.stages) {
    for (const [qid, q] of Object.entries(s.questions)) {
      const policy = spec.policies[qid];
      const questionPolicy = policy !== undefined && policy.type !== "composite" ? policy : undefined;
      const read = reads.get(qid);
      if (read === undefined) {
        decisions[qid] = emptyDecision("question");
        meta[qid] = { kind: "question", gating: questionPolicy?.gating ?? false, counts: true, actionRef: null, questionType: q.type, answer: null };
        continue;
      }
      const relevant = questionPolicy?.relevantWhen === undefined || evaluateCondition(questionPolicy.relevantWhen, baseCtx);
      const gating = questionPolicy?.gating ?? false;
      const band = read.view.band;
      const ref: ActionRef | null = questionPolicy === undefined ? null : questionPolicy.actions[band];
      const action: Action = ref?.kind ?? "fallback";
      // An answer no module could read is band low and a forced fallback in every stage.
      const eff = read.ok ? effectiveAction({ stage, band, action, gating, relevant }) : "fallback";
      const executed = read.ok && isExecuted({ ...execution, band, relevant, action, effectiveAction: eff, handler: ref?.handler });
      decisions[qid] = {
        kind: "question",
        value: ref === null ? read.view.value : applyFallbackValue(read.view.value, ref, executed),
        band,
        relevant,
        action,
        effectiveAction: eff,
        executed,
      };
      meta[qid] = { kind: "question", gating, counts: true, actionRef: ref, questionType: q.type, answer: read.ok ? read.answer : null };
    }
  }

  // 3. Composites: value from relevant, readable question terms and check terms; band is the
  // minimum band of the question terms (checks count as high); level picks the action.
  const compositeValues: Record<string, number | null> = {};
  for (const c of spec.composites ?? []) {
    const routed = routeComposite(c, decisions, meta, input.checks, execution);
    decisions[c.id] = routed.decision;
    meta[c.id] = routed.meta;
    compositeValues[c.id] = routed.value;
  }

  // 4. Routes: first match wins, then defaultRoute, then null. They read everything.
  const routeCtx: ConditionContext = { ...baseCtx, composites: compositeValues };
  const match = (spec.routes ?? []).find((r) => evaluateCondition(r.when, routeCtx));
  const route = match?.output ?? spec.defaultRoute ?? null;

  const { runBand, overallAction } = summarizeDecisions(decisions, meta);
  return { decisions, meta, views, composites: compositeValues, runBand, overallAction, route, warnings };
}

export interface OutageRouterInput {
  spec: QuestionSetSpec;
  /** Questions in a spec stage that was skipped before the outage. They stay skipped decisions. */
  skipped: ReadonlySet<string>;
  rollout: RolloutStage;
  channel: Channel;
  arm?: ExperimentArm | undefined;
}

/** The first escalate_to_llm action in a question policy (low band first), so an outage escalation reuses its config. */
function escalateRefOf(policy: QuestionPolicy): ActionRef {
  for (const band of ["low", "medium", "high"] as const) {
    const ref = policy.actions[band];
    if (ref.kind === "escalate_to_llm") return ref;
  }
  return { kind: "escalate_to_llm" };
}

/**
 * Decisions for a run whose System One call was unavailable after retries. Every decision
 * is band low with value null, so the caller always gets an instruction and never an empty set:
 * effectiveAction comes from outageEffectiveAction and the set's onUnavailable (never auto).
 * Relevance is not evaluated, since the answers it reads are missing; every question outside a
 * skipped stage counts as relevant. Routes do not run, so route is null.
 */
export function routeOutage(input: OutageRouterInput): RouterOutput {
  const { spec } = input;
  const stage = routingStage(input.rollout, input.channel);
  const onUnavailable = onUnavailableOf(spec);
  const decisions: Record<string, Decision> = {};
  const meta: Record<string, DecisionMeta> = {};
  const decide = (kind: "question" | "composite", gating: boolean): Decision => {
    const eff = outageEffectiveAction({ stage, kind, gating, relevant: true, onUnavailable });
    const executed = isOutageExecuted({ effectiveAction: eff, arm: input.arm });
    return { kind, value: null, band: "low", relevant: true, action: eff, effectiveAction: eff, executed };
  };

  for (const s of spec.stages) {
    for (const [qid, q] of Object.entries(s.questions)) {
      const policy = spec.policies[qid];
      const questionPolicy = policy !== undefined && policy.type !== "composite" ? policy : undefined;
      const gating = questionPolicy?.gating ?? false;
      const base = { kind: "question" as const, gating, counts: true, questionType: q.type, answer: null };
      if (input.skipped.has(qid)) {
        decisions[qid] = emptyDecision("question");
        meta[qid] = { ...base, actionRef: null };
        continue;
      }
      const d = decide("question", gating);
      decisions[qid] = d;
      // Only a gating question escalates, and a gating question has a question policy.
      meta[qid] = { ...base, actionRef: d.effectiveAction === "escalate_to_llm" ? escalateRefOf(questionPolicy as QuestionPolicy) : null };
    }
  }
  for (const c of spec.composites ?? []) {
    const gating = c.policy?.gating ?? false;
    decisions[c.id] = decide("composite", gating);
    meta[c.id] = { kind: "composite", gating, counts: c.policy !== undefined, actionRef: null, questionType: null, answer: null };
  }

  const { runBand, overallAction } = summarizeDecisions(decisions, meta);
  return { decisions, meta, views: {}, composites: {}, runBand, overallAction, route: null, warnings: [] };
}

function routeComposite(
  c: Composite,
  decisions: Readonly<Record<string, Decision>>,
  meta: Readonly<Record<string, DecisionMeta>>,
  checks: Readonly<Record<string, boolean>>,
  execution: { stage: RolloutStage; channel: Channel; dispatchActionsOnStaging: boolean; arm: ExperimentArm | undefined },
): { decision: Decision; meta: DecisionMeta; value: number | null } {
  let weighted = 0;
  let total = 0;
  const bands: Band[] = [];
  for (const term of c.terms) {
    if ("check" in term) {
      weighted += term.weight * (checks[term.check] === true ? 1 : 0);
      total += term.weight;
      bands.push("high");
      continue;
    }
    const d = decisions[term.q];
    const answer = meta[term.q]?.answer ?? null;
    // A term whose question is irrelevant, skipped or unreadable is left out; the rest renormalize.
    if (d === undefined || !d.relevant || answer === null) continue;
    weighted += term.weight * compositeTermValue(answer, term);
    total += term.weight;
    bands.push(d.band);
  }
  const policy = c.policy;
  const counts = policy !== undefined;
  if (total === 0) {
    return {
      decision: emptyDecision("composite"),
      meta: { kind: "composite", gating: policy?.gating ?? false, counts, actionRef: null, questionType: null, answer: null },
      value: null,
    };
  }
  const value = weighted / total;
  const band = minBand(bands);
  if (policy === undefined) {
    // No policy: never gates, only routes use it. auto, except fallback where every action is forced.
    const eff: Action = isShadowLike(execution.stage) ? "fallback" : "auto";
    return {
      decision: { kind: "composite", value, band, relevant: true, action: "auto", effectiveAction: eff, executed: false },
      meta: { kind: "composite", gating: false, counts: false, actionRef: null, questionType: null, answer: null },
      value,
    };
  }
  const level = compositeLevel(value, policy.levelThresholds);
  const ref = policy.actions[level];
  const eff = effectiveAction({ stage: execution.stage, band, action: ref.kind, gating: policy.gating, relevant: true });
  const executed = isExecuted({ ...execution, band, relevant: true, action: ref.kind, effectiveAction: eff, handler: ref.handler });
  return {
    decision: {
      kind: "composite",
      value: applyFallbackValue(value, ref, executed),
      band,
      level,
      relevant: true,
      action: ref.kind,
      effectiveAction: eff,
      executed,
    },
    meta: { kind: "composite", gating: policy.gating, counts: true, actionRef: ref, questionType: null, answer: null },
    value,
  };
}

/** The escalation config of a decision whose policy action is escalate_to_llm. */
export function escalationConfigOf(ref: ActionRef | CompositeActionRef | null): EscalationConfig | null {
  if (ref === null || ref.kind !== "escalate_to_llm") return null;
  return ref.config ?? {};
}

/** The fallback config of a decision whose policy action is fallback; noop when omitted. */
export function fallbackConfigOf(ref: ActionRef | CompositeActionRef | null): FallbackConfig | null {
  if (ref === null || ref.kind !== "fallback") return null;
  return ref.config ?? { kind: "noop" };
}
