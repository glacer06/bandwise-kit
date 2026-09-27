// The score question type: an ordered rubric, answered with a probability-weighted score.

import type { ScoreTypeModule } from "../contracts/question-types.js";
import { ScoreQuestion } from "../contracts/question-types.js";
import { ScoreAnswer, SYSTEM_ONE_LIMITS } from "../contracts/system-one.js";
import { manifestBase, thresholdBand } from "./shared.js";

/** Level count of a score answer: the rubric size the legend (or the probabilities) reports. */
export function scoreLevels(answer: { legend: Record<string, unknown>; probabilities: Record<string, number> }): number {
  return Math.max(Object.keys(answer.legend).length, Object.keys(answer.probabilities).length);
}

export const scoreModule: ScoreTypeModule = {
  id: "score",
  questionSchema: ScoreQuestion,
  answerSchema: ScoreAnswer,
  compile(q) {
    return { type: "score", instructions: q.instructions, criteria: [...q.criteria] };
  },
  band(answer, policy) {
    return { value: answer.score, band: thresholdBand(answer.confidence, policy.thresholds) };
  },
  compositeValue(answer) {
    const levels = scoreLevels(answer);
    if (levels < 2) return 0;
    return Math.min(1, Math.max(0, answer.score / (levels - 1)));
  },
  lints: [
    (q, at) => {
      const n = q.criteria.length;
      if (n >= SYSTEM_ONE_LIMITS.minScoreLevels && n <= SYSTEM_ONE_LIMITS.maxScoreLevels) return [];
      return [
        {
          rule: "score.levels_range",
          severity: "error",
          path: `${at.path}/criteria`,
          message: `score "${at.questionId}" has ${n} levels; the API allows ${SYSTEM_ONE_LIMITS.minScoreLevels} to ${SYSTEM_ONE_LIMITS.maxScoreLevels}`,
        },
      ];
    },
  ],
  manifestHint(q) {
    return { ...manifestBase("score", q.meta), levels: q.criteria.length };
  },
  uiKind: "scale",
};
