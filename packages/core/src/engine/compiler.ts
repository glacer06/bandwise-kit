// The spec compiler: one spec stage to a System One request body,
// through each question's QuestionTypeModule. The compiler never adds, drops or rewrites what the
// spec says; it only shapes it into the API body.

import type { QuestionId } from "../contracts/common.js";
import type { SpecStage } from "../contracts/spec.js";
import type { SystemOneQuestion, SystemOneRequest } from "../contracts/system-one.js";
import { compileQuestion } from "../question-types/index.js";

/** Every question of a spec stage as an API question body, keyed by question id, in spec order. */
export function compileStageQuestions(stage: Pick<SpecStage, "questions">): Record<QuestionId, SystemOneQuestion> {
  const out: Record<QuestionId, SystemOneQuestion> = {};
  for (const [qid, q] of Object.entries(stage.questions)) out[qid] = compileQuestion(q);
  return out;
}

/**
 * One request body. `model` is the id sent on the run's provider (the route's providerModelId),
 * which is the registry id itself on TypeSafe.
 */
export function compileRequest(
  questions: Readonly<Record<QuestionId, SystemOneQuestion>>,
  state: unknown,
  model: string,
): SystemOneRequest {
  return { state, model, questions: { ...questions } };
}

/** Compile a whole spec stage for one state. */
export function compileStage(stage: Pick<SpecStage, "questions">, state: unknown, model: string): SystemOneRequest {
  return compileRequest(compileStageQuestions(stage), state, model);
}
