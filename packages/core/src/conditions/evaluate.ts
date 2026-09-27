// The condition grammar evaluator. Conditions are data; this is the
// only place they run. Leaves that point at a question that was not asked, a composite with no
// value, or an input path that does not resolve are false. `exists: false` is the one leaf that
// is true in that case.

import type { Band, Value } from "../contracts/common.js";
import type { Condition } from "../contracts/policy.js";
import { roundHalfUp } from "../util/numbers.js";
import { linearMatch } from "../util/regex.js";
import { resolveStatePath } from "../util/state-path.js";

/** What a condition may read about one asked question: the model's answer before rollout or fallback. */
export interface QuestionView {
  /** The question type, or the raw answer type when no module knows it. */
  type: string;
  /** Choice: option key. Noul: true, false or null. Score: the raw score. Unknown: null. */
  value: Value;
  band: Band;
  /** Noul: the noul. Score: the raw score. Otherwise null. */
  numeric: number | null;
}

export interface ConditionContext {
  /** The validated input, before redaction. */
  input: unknown;
  /** Check results by check id. */
  checks: Readonly<Record<string, boolean>>;
  /** Asked questions by id. A question that was not asked has no entry. */
  questions: Readonly<Record<string, QuestionView>>;
  /** Composite values (0 to 1) by id; null when no term was left. */
  composites: Readonly<Record<string, number | null>>;
}

/** An empty context: no input, checks, answers or composites. */
export const EMPTY_CONTEXT: ConditionContext = Object.freeze({
  input: undefined,
  checks: Object.freeze({}),
  questions: Object.freeze({}),
  composites: Object.freeze({}),
});

function inRange(n: unknown, c: { gte?: number | undefined; lte?: number | undefined }): boolean {
  if (typeof n !== "number" || Number.isNaN(n)) return false;
  if (c.gte !== undefined && n < c.gte) return false;
  if (c.lte !== undefined && n > c.lte) return false;
  return true;
}

/** The value `eq`, `neq` and `in` compare: a score compares its nearest 0-based level index. */
function comparable(view: QuestionView): Value {
  if (view.type === "score" && typeof view.value === "number") return roundHalfUp(view.value);
  return view.value;
}

/** Evaluate a condition. Pure and total: it never throws on data it cannot read. */
export function evaluateCondition(cond: Condition, ctx: ConditionContext): boolean {
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, ctx));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, ctx));
  if ("not" in cond) return !evaluateCondition(cond.not, ctx);
  if ("check" in cond) return ctx.checks[cond.check] === true;
  if ("composite" in cond) {
    const v = Object.hasOwn(ctx.composites, cond.composite) ? ctx.composites[cond.composite] : null;
    return inRange(v, cond);
  }
  if ("q" in cond) {
    const view = Object.hasOwn(ctx.questions, cond.q) ? ctx.questions[cond.q] : undefined;
    if (view === undefined) return false;
    if ("eq" in cond) return comparable(view) === cond.eq;
    if ("neq" in cond) return comparable(view) !== cond.neq;
    if ("in" in cond) return cond.in.includes(comparable(view));
    if ("band" in cond) return view.band === cond.band;
    return inRange(view.numeric, cond);
  }
  const value = resolveStatePath(ctx.input, cond.input);
  if ("exists" in cond) return (value !== undefined) === cond.exists;
  if (value === undefined) return false;
  if ("eq" in cond) return value === cond.eq;
  if ("neq" in cond) return value !== cond.neq;
  if ("in" in cond) return cond.in.includes(value as Value);
  if ("matches" in cond) return typeof value === "string" && linearMatch(cond.matches, value);
  return inRange(value, cond);
}

/** Every question id a condition reads. */
export function conditionQuestionIds(cond: Condition): string[] {
  if ("all" in cond) return cond.all.flatMap(conditionQuestionIds);
  if ("any" in cond) return cond.any.flatMap(conditionQuestionIds);
  if ("not" in cond) return conditionQuestionIds(cond.not);
  if ("q" in cond) return [cond.q];
  return [];
}

/** Every input path a condition reads. */
export function conditionInputPaths(cond: Condition): string[] {
  if ("all" in cond) return cond.all.flatMap(conditionInputPaths);
  if ("any" in cond) return cond.any.flatMap(conditionInputPaths);
  if ("not" in cond) return conditionInputPaths(cond.not);
  if ("input" in cond) return [cond.input];
  return [];
}
