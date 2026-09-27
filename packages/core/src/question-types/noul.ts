// The noul question type: yes or no, answered with the probability of yes.

import type { Band, Value } from "../contracts/common.js";
import type { NoulTypeModule } from "../contracts/question-types.js";
import { NoulQuestion } from "../contracts/question-types.js";
import { NoulAnswer } from "../contracts/system-one.js";
import type { JsonObject } from "../contracts/common.js";
import { edge } from "../util/numbers.js";
import { manifestBase } from "./shared.js";

/**
 * The noul band rule. A noul near 0.5 means yes and no are about equally likely, so it lands in
 * the low band with value null. It is not a medium-strength yes.
 */
export function noulBand(noul: number, t: { trueAt: number; falseAt: number; reviewMargin: number }): {
  value: Value;
  band: Band;
} {
  if (noul >= t.trueAt) return { value: true, band: "high" };
  if (noul <= t.falseAt) return { value: false, band: "high" };
  if (noul >= edge(t.trueAt - t.reviewMargin)) return { value: true, band: "medium" };
  if (noul <= edge(t.falseAt + t.reviewMargin)) return { value: false, band: "medium" };
  return { value: null, band: "low" };
}

export const noulModule: NoulTypeModule = {
  id: "noul",
  questionSchema: NoulQuestion,
  answerSchema: NoulAnswer,
  compile(q) {
    const out: { type: "noul"; instructions: typeof q.instructions; criteria?: JsonObject } = {
      type: "noul",
      instructions: q.instructions,
    };
    if (q.criteria !== undefined) {
      const criteria: JsonObject = {};
      for (const [k, v] of Object.entries(q.criteria)) if (v !== undefined) criteria[k] = v;
      out.criteria = criteria;
    }
    return out;
  },
  band(answer, policy) {
    return noulBand(answer.noul, policy.noul);
  },
  compositeValue(answer) {
    return Math.min(1, Math.max(0, answer.noul));
  },
  lints: [],
  manifestHint(q) {
    return manifestBase("noul", q.meta);
  },
  uiKind: "boolean",
};
