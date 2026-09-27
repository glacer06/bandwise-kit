// Helpers the question-type modules share.

import type { Band, Value } from "../contracts/common.js";
import type { Thresholds } from "../contracts/policy.js";
import type { ManifestQuestion, QuestionMeta, QuestionTypeId } from "../contracts/question-types.js";

/** Choice and score: `confidence` against the thresholds. */
export function thresholdBand(confidence: number, t: Thresholds): Band {
  if (confidence >= t.high) return "high";
  if (confidence >= t.medium) return "medium";
  return "low";
}

/** The manifest fields every type shares. */
export function manifestBase(type: QuestionTypeId, meta: QuestionMeta): ManifestQuestion {
  const hint: ManifestQuestion = { type, label: meta.label };
  if (meta.description !== undefined) hint.description = meta.description;
  return hint;
}

/** The value-and-band pair a band function returns. */
export interface Banded {
  value: Value;
  band: Band;
}
