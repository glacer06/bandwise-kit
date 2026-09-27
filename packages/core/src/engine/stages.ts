// Stage orchestration helpers: checks, `when` conditions and the state
// each spec stage sends, including `stateFrom` merges.

import type { QuestionId } from "../contracts/common.js";
import type { Check } from "../contracts/policy.js";
import { RESERVED_STATE_KEY, type SpecStage } from "../contracts/spec.js";
import type { SystemOneAnswer } from "../contracts/system-one.js";
import { type ConditionContext, type QuestionView, conditionQuestionIds, evaluateCondition } from "../conditions/evaluate.js";

/** Evaluate every check on the validated input. Checks read input only. */
export function evaluateChecks(checks: readonly Check[] | undefined, input: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const ctx: ConditionContext = { input, checks: {}, questions: {}, composites: {} };
  for (const c of checks ?? []) out[c.id] = evaluateCondition(c.when, ctx);
  return out;
}

/** True when a stage's `when` reads an answer, so it cannot be decided before earlier calls. */
export function whenReadsAnswers(stage: Pick<SpecStage, "when">): boolean {
  return stage.when !== undefined && conditionQuestionIds(stage.when).length > 0;
}

/** True when the stage runs: no `when`, or its `when` holds on input, checks and earlier answers. */
export function stageRuns(stage: Pick<SpecStage, "when">, ctx: ConditionContext): boolean {
  return stage.when === undefined || evaluateCondition(stage.when, ctx);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The state one spec stage sends. `stateFrom: "input"` (the default) sends the redacted input. A
 * merge adds `answers.<qid> = { value, band }` for each listed question that was asked, plus
 * `probabilities` (choice and score) or `noul` (noul) when asked for. A non-object input is kept
 * under `input` so `answers` has a place next to it.
 */
export function stageState(
  stage: Pick<SpecStage, "stateFrom">,
  redactedInput: unknown,
  views: Readonly<Record<QuestionId, QuestionView>>,
  answers: Readonly<Record<QuestionId, SystemOneAnswer>>,
): unknown {
  const from = stage.stateFrom;
  if (from === undefined || from === "input") return redactedInput;
  const base: Record<string, unknown> = isPlainObject(redactedInput) ? { ...redactedInput } : { input: redactedInput };
  const merged: Record<string, unknown> = {};
  for (const qid of from.merge.answers) {
    const view = views[qid];
    if (view === undefined) continue;
    const entry: Record<string, unknown> = { value: view.value, band: view.band };
    const raw = answers[qid];
    if (from.merge.probabilities === true && raw !== undefined) {
      if ("probabilities" in raw) entry["probabilities"] = raw["probabilities"];
      if ("noul" in raw) entry["noul"] = raw["noul"];
    }
    merged[qid] = entry;
  }
  base[RESERVED_STATE_KEY] = merged;
  return base;
}

/** The pure default Redactor: a copy of the state with each path replaced by "[redacted]". */
export function redactPathsDefault(state: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return state;
  const copy: unknown = structuredCloneJson(state);
  for (const path of paths) {
    const parts = path.match(/[^.[\]]+/g) ?? [];
    let cur: unknown = copy;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== "object") break;
      const key = parts[i] as string;
      const container = cur as Record<string, unknown>;
      if (!Object.hasOwn(container, key)) break;
      if (i === parts.length - 1) container[key] = "[redacted]";
      else cur = container[key];
    }
  }
  return copy;
}

function structuredCloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
