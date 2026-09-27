// The question-type module map. The router, compiler, composites,
// manifest, editor and Studio iterate this map instead of switching on the type string.

import type {
  AnswerOf,
  QuestionTypeId,
  QuestionTypeModule,
  QuestionTypeModules,
} from "../contracts/question-types.js";
import type { QuestionDef } from "../contracts/question-types.js";
import type { SystemOneQuestion } from "../contracts/system-one.js";
import { choiceModule } from "./choice.js";
import { noulModule } from "./noul.js";
import { scoreModule } from "./score.js";

export { noulBand } from "./noul.js";
export { hasNoneOption } from "./choice.js";
export { scoreLevels } from "./score.js";
export { thresholdBand } from "./shared.js";

export const questionTypes: QuestionTypeModules = {
  noul: noulModule,
  choice: choiceModule,
  score: scoreModule,
};

/** The module for a type id. */
export function moduleFor<K extends QuestionTypeId>(type: K): QuestionTypeModule<K> {
  return questionTypes[type];
}

/** Compile one question to its API body through its module. */
export function compileQuestion(q: QuestionDef): SystemOneQuestion {
  const compile = moduleFor(q.type).compile as (question: QuestionDef) => SystemOneQuestion;
  return compile(q);
}

/**
 * Parse an answer with the module of the question that was asked. Null when the answer's type
 * differs from the question's, or does not fit the type's schema.
 */
export function parseAnswerFor<K extends QuestionTypeId>(type: K, answer: unknown): AnswerOf<K> | null {
  const result = moduleFor(type).answerSchema.safeParse(answer);
  return result.success ? result.data : null;
}
