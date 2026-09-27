// The choice question type: one option from a set, with probabilities and confidence.

import type { ChoiceTypeModule } from "../contracts/question-types.js";
import { ChoiceQuestion } from "../contracts/question-types.js";
import { ChoiceAnswer, SYSTEM_ONE_LIMITS } from "../contracts/system-one.js";
import { manifestBase, thresholdBand } from "./shared.js";

/** Option keys that read as "nothing fits" (lint `choice.missing_none`). */
const NONE_OPTION = /(^|_)(none|other|others|neither|unknown|unclear|not_stated|not_applicable|n_a|no_match)(_|$)/;

/** True when a choice offers a "none of these" style option. */
export function hasNoneOption(options: readonly string[]): boolean {
  return options.some((o) => NONE_OPTION.test(o.toLowerCase()));
}

export const choiceModule: ChoiceTypeModule = {
  id: "choice",
  questionSchema: ChoiceQuestion,
  answerSchema: ChoiceAnswer,
  compile(q) {
    return { type: "choice", instructions: q.instructions, criteria: { ...q.criteria } };
  },
  band(answer, policy) {
    const t = policy.perOption?.[answer.choice] ?? policy.thresholds;
    return { value: answer.choice, band: thresholdBand(answer.confidence, t) };
  },
  compositeValue(answer, term) {
    if (term.option === undefined) return 0;
    const p = answer.probabilities[term.option] ?? 0;
    return Math.min(1, Math.max(0, p));
  },
  lints: [
    (q, at) => {
      const options = Object.keys(q.criteria);
      const out = [];
      if (!hasNoneOption(options)) {
        out.push({
          rule: "choice.missing_none",
          severity: "warning" as const,
          path: `${at.path}/criteria`,
          message: `choice "${at.questionId}" has no "none of these" option; without one the model must spread probability over wrong answers`,
        });
      }
      if (options.length > SYSTEM_ONE_LIMITS.maxChoiceOptions) {
        out.push({
          rule: "choice.too_many_options",
          severity: "error" as const,
          path: `${at.path}/criteria`,
          message: `choice "${at.questionId}" has ${options.length} options; the API allows at most ${SYSTEM_ONE_LIMITS.maxChoiceOptions}`,
        });
      }
      return out;
    },
  ],
  manifestHint(q) {
    return { ...manifestBase("choice", q.meta), options: Object.keys(q.criteria) };
  },
  uiKind: "options",
};
