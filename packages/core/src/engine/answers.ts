// Reading one raw answer against the question that was asked: the view conditions read, and the
// typed answer the router and composites use. Every per-type step goes through the module map.

import type { ConfidencePolicy, QuestionPolicy } from "../contracts/policy.js";
import type { QuestionDef, QuestionTypeId, QuestionTypeModule } from "../contracts/question-types.js";
import { isQuestionTypeId } from "../contracts/question-types.js";
import type { KnownAnswer, SystemOneAnswer } from "../contracts/system-one.js";
import type { QuestionView } from "../conditions/evaluate.js";
import { questionTypes } from "../question-types/index.js";

/** Warnings a question can add to a run. */
export const ANSWER_WARNINGS = {
  unknownType: "unknown_answer_type",
  typeMismatch: "answer_type_mismatch",
  missing: "answer_missing",
  policyMissing: "policy_missing",
} as const;

/** The module map viewed through the union of its type ids. Callers check that the types agree first. */
const anyModule = (type: QuestionTypeId): QuestionTypeModule<QuestionTypeId> =>
  questionTypes[type] as unknown as QuestionTypeModule<QuestionTypeId>;

export type ReadAnswer =
  | { ok: true; answer: KnownAnswer; policy: QuestionPolicy; view: QuestionView }
  | { ok: false; view: QuestionView; warning: string };

const lowView = (type: string): QuestionView => ({ type, value: null, band: "low", numeric: null });

/**
 * Read a raw answer for an asked question. An answer of a type no module knows, of another type
 * than the question, one that does not fit its type's schema, a missing answer, or a question with
 * no matching policy all read as value null and band low, with a warning. Nothing throws.
 */
export function readAnswer(
  question: QuestionDef,
  policy: ConfidencePolicy | undefined,
  raw: SystemOneAnswer | undefined,
): ReadAnswer {
  if (raw === undefined) return { ok: false, view: lowView(question.type), warning: ANSWER_WARNINGS.missing };
  if (!isQuestionTypeId(raw.type)) return { ok: false, view: lowView(raw.type), warning: ANSWER_WARNINGS.unknownType };
  const parsed = raw.type === question.type ? anyModule(question.type).answerSchema.safeParse(raw) : null;
  if (parsed === null || !parsed.success) {
    return { ok: false, view: lowView(question.type), warning: ANSWER_WARNINGS.typeMismatch };
  }
  const answer = parsed.data;
  if (policy === undefined || policy.type !== question.type) {
    return { ok: false, view: lowView(question.type), warning: ANSWER_WARNINGS.policyMissing };
  }
  const { value, band } = anyModule(question.type).band(answer, policy);
  return { ok: true, answer, policy, view: { type: question.type, value, band, numeric: numericOf(answer) } };
}

/** Noul: the noul. Score: the raw score. Choice: none. */
function numericOf(answer: KnownAnswer): number | null {
  if (answer.type === "noul") return answer.noul;
  if (answer.type === "score") return answer.score;
  return null;
}

/** The 0 to 1 composite term value of a typed answer, through its module. */
export function compositeTermValue(answer: KnownAnswer, term: { q: string; weight: number; option?: string | undefined }): number {
  // Every v1 module defines compositeValue.
  const fn = anyModule(answer.type).compositeValue as NonNullable<QuestionTypeModule<QuestionTypeId>["compositeValue"]>;
  return fn(answer, term);
}
