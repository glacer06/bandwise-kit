// Token preflight. Limits come from the effective model limits (the
// profile's, tightened by the provider's route), never from constants. State plus the longest
// question must fit statePlusLongestQuestionTokens, and each request must fit requestTokens. A
// stage that fits the first rule but not the second is split into parallel batches.

import type { QuestionId } from "../contracts/common.js";
import type { SystemOneQuestion, SystemOneRequest } from "../contracts/system-one.js";
import { estimateTokens } from "../util/tokens.js";
import { compileRequest } from "./compiler.js";

/** The limits preflight reads. */
export interface PreflightLimits {
  requestTokens: number;
  statePlusLongestQuestionTokens: number;
}

/** Share of a limit above which preflight warns. */
export const PREFLIGHT_WARN_RATIO = 0.8;

/** Tokens for the request envelope around state and questions: model name and JSON punctuation. */
export const REQUEST_OVERHEAD_TOKENS = 16;

export const PREFLIGHT_WARNINGS = { nearLimit: "preflight_near_limit" } as const;

export interface PreflightBatch {
  request: SystemOneRequest;
  estTokens: number;
  questionIds: QuestionId[];
}

export type PreflightResult =
  | {
      ok: true;
      batches: PreflightBatch[];
      stateTokens: number;
      questionTokens: Record<QuestionId, number>;
      warnings: string[];
    }
  | { ok: false; message: string; stateTokens: number };

/** Estimated tokens of one question entry, id included. */
export function questionTokens(id: QuestionId, q: SystemOneQuestion): number {
  return estimateTokens({ [id]: q });
}

/** Check one stage against the limits and split it into batches when a single request is too big. */
export function preflightStage(
  questions: Readonly<Record<QuestionId, SystemOneQuestion>>,
  state: unknown,
  model: string,
  limits: PreflightLimits,
  maxStateTokens?: number,
): PreflightResult {
  const stateTokens = estimateTokens(state);
  if (maxStateTokens !== undefined && stateTokens > maxStateTokens) {
    return { ok: false, stateTokens, message: `state is about ${stateTokens} tokens; input.maxStateTokens is ${maxStateTokens}` };
  }
  const qTokens: Record<QuestionId, number> = {};
  for (const [id, q] of Object.entries(questions)) qTokens[id] = questionTokens(id, q);
  const longest = Math.max(0, ...Object.values(qTokens));
  const base = stateTokens + REQUEST_OVERHEAD_TOKENS;
  if (stateTokens + longest > limits.statePlusLongestQuestionTokens) {
    return {
      ok: false,
      stateTokens,
      message: `state plus the longest question is about ${stateTokens + longest} tokens; the model allows ${limits.statePlusLongestQuestionTokens}`,
    };
  }
  if (base + longest > limits.requestTokens) {
    return { ok: false, stateTokens, message: `one request is about ${base + longest} tokens; the model allows ${limits.requestTokens}` };
  }

  // Greedy split in spec order: each batch carries the full state and as many questions as fit.
  const groups: QuestionId[][] = [];
  let current: QuestionId[] = [];
  let used = base;
  for (const id of Object.keys(questions)) {
    const t = qTokens[id] as number;
    if (current.length > 0 && used + t > limits.requestTokens) {
      groups.push(current);
      current = [];
      used = base;
    }
    current.push(id);
    used += t;
  }
  groups.push(current);

  const batches = groups.map((ids) => {
    const subset: Record<QuestionId, SystemOneQuestion> = {};
    for (const id of ids) subset[id] = questions[id] as SystemOneQuestion;
    const estTokens = base + ids.reduce((n, id) => n + (qTokens[id] as number), 0);
    return { request: compileRequest(subset, state, model), estTokens, questionIds: ids };
  });

  const warnings: string[] = [];
  const nearRequest = batches.some((b) => b.estTokens > PREFLIGHT_WARN_RATIO * limits.requestTokens);
  const nearState = stateTokens + longest > PREFLIGHT_WARN_RATIO * limits.statePlusLongestQuestionTokens;
  if (nearRequest || nearState) warnings.push(PREFLIGHT_WARNINGS.nearLimit);
  return { ok: true, batches, stateTokens, questionTokens: qTokens, warnings };
}
