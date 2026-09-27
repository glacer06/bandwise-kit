// Lints that read only the spec.

import type { ConfidencePolicy, Thresholds } from "../contracts/policy.js";
import type { LintResult, QuestionSetSpec } from "../contracts/spec.js";
import {
  ON_UNAVAILABLE_ACTIONS,
  OUTAGE_AUTO_NOT_ALLOWED_MESSAGE,
  OUTAGE_AUTO_NOT_ALLOWED_RULE,
  RESERVED_STATE_KEY,
} from "../contracts/spec.js";
import type { QuestionDef, QuestionTypeLint } from "../contracts/question-types.js";
import { conditionQuestionIds } from "../conditions/evaluate.js";
import { questionTypes } from "../question-types/index.js";
import { schemaAtPath } from "../util/json-schema.js";
import { parseStatePath } from "../util/state-path.js";
import { finding, questionEntries, seg, statePathsOf, textOf, wordCount } from "./helpers.js";

/** Minimum words in a question's instructions (lint instructions.too_short). */
export const MIN_INSTRUCTION_WORDS = 8;

const PREMISE = /\b(if|assume|assuming|given|when|suppose|supposing|provided|in case)\b/i;

/** Per-type lints from each question's module (choice.missing_none, score.levels_range, ...). */
export function moduleLints(spec: QuestionSetSpec): LintResult[] {
  return questionEntries(spec).flatMap(({ id, question, path }) => {
    const lints = questionTypes[question.type].lints as QuestionTypeLint<QuestionDef>[];
    return lints.flatMap((l) => l(question, { questionId: id, path }));
  });
}

/** state_path.unknown, stage.same_stage_dependency (through answers paths) and redact.path_unknown. */
export function pathLints(spec: QuestionSetSpec): LintResult[] {
  const out: LintResult[] = [];
  const stageOf = new Map(questionEntries(spec).map((e) => [e.id, e.stageIndex]));
  for (const { id, question, path, stageIndex } of questionEntries(spec)) {
    const stage = spec.stages[stageIndex];
    const merged = typeof stage?.stateFrom === "object" ? stage.stateFrom.merge.answers : [];
    for (const p of statePathsOf(question)) {
      const segments = parseStatePath(p) ?? [];
      const first = segments[0];
      const second = segments[1];
      if (first !== undefined && "key" in first && first.key === RESERVED_STATE_KEY) {
        const qid = second !== undefined && "key" in second ? second.key : "";
        if (stageOf.get(qid) === stageIndex) {
          out.push(finding("stage.same_stage_dependency", "error", path, `"${id}" reads \`${p}\`, an answer from its own stage; questions in one stage cannot see each other`));
        } else if (!merged.includes(qid)) {
          out.push(finding("state_path.unknown", "error", path, `"${id}" reads \`${p}\`, but stage "${stage?.id}" does not merge answers.${qid}`));
        }
        continue;
      }
      if (schemaAtPath(spec.input.schema, segments) === null) {
        out.push(finding("state_path.unknown", "error", path, `"${id}" reads \`${p}\`, which input.schema does not define`));
      }
    }
  }
  (spec.input.redactPaths ?? []).forEach((p, i) => {
    const segments = parseStatePath(p);
    if (segments === null || schemaAtPath(spec.input.schema, segments) === null) {
      out.push(finding("redact.path_unknown", "error", `/input/redactPaths/${i}`, `redact path "${p}" does not resolve in input.schema`));
    }
  });
  return out;
}

/** stage.same_stage_dependency for `when` and merges, and stage.needless_second_call. */
export function stageLints(spec: QuestionSetSpec): LintResult[] {
  const out: LintResult[] = [];
  const stageOf = new Map(questionEntries(spec).map((e) => [e.id, e.stageIndex]));
  spec.stages.forEach((stage, i) => {
    const read = stage.when === undefined ? [] : conditionQuestionIds(stage.when);
    for (const qid of read) {
      const at = stageOf.get(qid);
      if (at !== undefined && at >= i) {
        out.push(finding("stage.same_stage_dependency", "error", `/stages/${i}/when`, `stage "${stage.id}" decides on "${qid}", which is not answered before it`));
      }
    }
    const merged = typeof stage.stateFrom === "object" ? stage.stateFrom.merge.answers : [];
    for (const qid of merged) {
      const at = stageOf.get(qid);
      if (at === undefined || at >= i) {
        out.push(finding("stage.same_stage_dependency", "error", `/stages/${i}/stateFrom`, `stage "${stage.id}" merges "${qid}", which is not answered in an earlier stage`));
      }
    }
    if (i > 0 && read.length > 0 && merged.length === 0) {
      out.push(
        finding(
          "stage.needless_second_call",
          "warning",
          `/stages/${i}`,
          `stage "${stage.id}" only decides on earlier answers and sends the same input; ask its questions in the earlier stage and use relevantWhen`,
        ),
      );
    }
  });
  return out;
}

const orderProblem = (t: Thresholds): boolean => t.medium > t.high;

/** The policy rules: type match, threshold order, noul order, per-option keys, all gating, premise. */
export function policyLints(spec: QuestionSetSpec): LintResult[] {
  const out: LintResult[] = [];
  const entries = questionEntries(spec);
  const ids = new Set(entries.map((e) => e.id));
  for (const { id, question } of entries) {
    const policy = spec.policies[id];
    if (policy === undefined) {
      out.push(finding("policy.type_mismatch", "error", `/policies/${seg(id)}`, `question "${id}" has no policy`));
    } else if (policy.type !== question.type) {
      out.push(finding("policy.type_mismatch", "error", `/policies/${seg(id)}/type`, `question "${id}" is a ${question.type}, its policy is a ${policy.type}`));
    }
  }
  for (const key of Object.keys(spec.policies)) {
    if (!ids.has(key)) out.push(finding("policy.type_mismatch", "error", `/policies/${seg(key)}`, `policy "${key}" names no question`));
  }

  const check = (policy: ConfidencePolicy, base: string): void => {
    if (policy.type === "noul") {
      const { trueAt, falseAt, reviewMargin } = policy.noul;
      if (!(0 < falseAt && falseAt < trueAt && trueAt < 1) || !(falseAt + reviewMargin < trueAt - reviewMargin)) {
        out.push(finding("policy.noul_order", "error", `${base}/noul`, "noul settings must satisfy 0 < falseAt < trueAt < 1 and falseAt + reviewMargin < trueAt - reviewMargin"));
      }
      return;
    }
    const t = policy.type === "composite" ? policy.levelThresholds : policy.thresholds;
    const at = policy.type === "composite" ? `${base}/levelThresholds` : `${base}/thresholds`;
    if (orderProblem(t)) out.push(finding("policy.thresholds_order", "error", at, "medium is above high"));
    if (policy.type === "choice") {
      for (const [option, pt] of Object.entries(policy.perOption ?? {})) {
        if (orderProblem(pt)) out.push(finding("policy.thresholds_order", "error", `${base}/perOption/${seg(option)}`, "medium is above high"));
      }
    }
  };
  for (const [key, policy] of Object.entries(spec.policies)) check(policy, `/policies/${seg(key)}`);
  (spec.composites ?? []).forEach((c, i) => {
    if (c.policy !== undefined) check(c.policy, `/composites/${i}/policy`);
  });

  for (const { id, question } of entries) {
    const policy = spec.policies[id];
    if (question.type !== "choice" || policy?.type !== "choice") continue;
    for (const option of Object.keys(policy.perOption ?? {})) {
      if (!Object.hasOwn(question.criteria, option)) {
        out.push(finding("policy.per_option_keys", "error", `/policies/${seg(id)}/perOption/${seg(option)}`, `"${option}" is not an option of "${id}"`));
      }
    }
  }

  const policies = entries.map((e) => spec.policies[e.id]);
  const thresholded = (p: ConfidencePolicy | undefined): boolean =>
    p !== undefined && p.gating && (p.type === "noul" || (p.type !== "composite" && (p.thresholds.high > 0 || p.thresholds.medium > 0)));
  if (entries.some((e) => e.question.type === "choice") && policies.every(thresholded)) {
    out.push(
      finding(
        "policy.all_gating_thresholded",
        "warning",
        "/policies",
        "every question is gating and thresholded; where only the best option matters, use the top-choice preset",
      ),
    );
  }

  for (const { id, question, path } of entries) {
    const policy = spec.policies[id];
    if (policy !== undefined && policy.type !== "composite" && policy.relevantWhen !== undefined && !PREMISE.test(textOf(question.instructions))) {
      out.push(
        finding("relevance.premise_missing", "warning", `${path}/instructions`, `"${id}" has relevantWhen; state the premise in its instructions ("If this is a work request, ...")`),
      );
    }
    if (wordCount(textOf(question.instructions)) < MIN_INSTRUCTION_WORDS) {
      out.push(finding("instructions.too_short", "warning", `${path}/instructions`, `"${id}" has fewer than ${MIN_INSTRUCTION_WORDS} words of instructions; the question id is never sent to the model, so the requirement has to be in the instructions and option descriptions`));
    }
  }
  return out;
}

/**
 * outage.auto_not_allowed: an outage gives no answer to act on, so the outage rule is
 * never auto. The strict schema already refuses it; this catches a spec built in code without it.
 * outage.fallback_silent: see fallbackSilentLints.
 */
export function outageLints(spec: QuestionSetSpec): LintResult[] {
  const rule: unknown = (spec as { onUnavailable?: unknown }).onUnavailable;
  if (rule === "fallback") return fallbackSilentLints(spec);
  if (rule === undefined || (ON_UNAVAILABLE_ACTIONS as readonly unknown[]).includes(rule)) return [];
  const message =
    rule === "auto" ? OUTAGE_AUTO_NOT_ALLOWED_MESSAGE : `onUnavailable must be one of ${ON_UNAVAILABLE_ACTIONS.join(", ")}`;
  return [finding(OUTAGE_AUTO_NOT_ALLOWED_RULE, "error", "/onUnavailable", message)];
}

/**
 * outage.fallback_silent: onUnavailable is explicitly `fallback` and the set
 * has gating decisions. An outage runs no FallbackConfig, so every gating
 * decision comes back as `fallback` with no value and the app decides on its own, with nobody told
 * unless the app says so. The default (`review`) never raises it.
 */
function fallbackSilentLints(spec: QuestionSetSpec): LintResult[] {
  const silent: string[] = [];
  for (const { id } of questionEntries(spec)) {
    const policy = spec.policies[id];
    if (policy !== undefined && policy.type !== "composite" && policy.gating) silent.push(id);
  }
  for (const c of spec.composites ?? []) {
    if (c.policy?.gating === true) silent.push(c.id);
  }
  if (silent.length === 0) return [];
  const ids = silent.map((id) => `"${id}"`).join(", ");
  return [
    finding(
      "outage.fallback_silent",
      "warning",
      "/onUnavailable",
      `onUnavailable is fallback: on an outage ${ids} come back as fallback with no value, so the app decides on its own and nobody is told unless it says so; use review to send outages to a person`,
    ),
  ];
}
