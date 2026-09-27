// escalate_to_llm. Core builds the LLM
// request and reads the reply. The LLM must return one value of the question's type: an option key
// for a choice, true or false for a noul, or a 0-based level index for a score.

import type { Value } from "../contracts/common.js";
import type { EscalationConfig } from "../contracts/policy.js";
import { ESCALATION_DEFAULT_MAX_OUTPUT_TOKENS } from "../contracts/policy.js";
import type { LlmCompletionRequest } from "../contracts/ports.js";
import type { QuestionDef, QuestionOf, QuestionTypeId } from "../contracts/question-types.js";
import { canonicalJson } from "../util/canonical-json.js";

interface EscalationType<K extends QuestionTypeId> {
  /** What the reply must be, in words, for the system prompt. */
  answerFormat(q: QuestionOf<K>): string;
  /** The value a reply names, or null when it is not one value of the type. */
  parse(q: QuestionOf<K>, reply: string): Value;
}

const escalationTypes: { [K in QuestionTypeId]: EscalationType<K> } = {
  noul: {
    answerFormat: () => "Reply with exactly one word: true or false.",
    parse: (_q, reply) => {
      const r = reply.toLowerCase();
      if (r === "true" || r === "yes") return true;
      if (r === "false" || r === "no") return false;
      return null;
    },
  },
  choice: {
    answerFormat: (q) => `Reply with exactly one option key from this list: ${Object.keys(q.criteria).join(", ")}.`,
    parse: (q, reply) => (Object.hasOwn(q.criteria, reply) ? reply : null),
  },
  score: {
    answerFormat: (q) => `Reply with exactly one level index, an integer from 0 to ${q.criteria.length - 1}.`,
    parse: (q, reply) => {
      if (!/^\d+$/.test(reply)) return null;
      const n = Number(reply);
      return n < q.criteria.length ? n : null;
    },
  },
};

const typeFor = (type: QuestionTypeId): EscalationType<QuestionTypeId> =>
  escalationTypes[type] as unknown as EscalationType<QuestionTypeId>;

/** The comparator model an escalation uses: its own, else the set's comparator, else the org default. */
export function escalationModel(config: EscalationConfig, specComparator: string | undefined, orgDefault: string): string {
  return config.model ?? specComparator ?? orgDefault;
}

/** The LLM request for one escalated question, on the same redacted state the System One call got. */
export function buildEscalationRequest(
  question: QuestionDef,
  config: EscalationConfig,
  state: unknown,
  model: string,
): LlmCompletionRequest {
  const system = [
    "You answer one classification question about the state below.",
    typeFor(question.type).answerFormat(question),
    "Do not explain.",
  ].join(" ");
  const parts: Record<string, unknown> = { question: question.instructions };
  if (question.criteria !== undefined) parts["criteria"] = question.criteria;
  if (config.instructions !== undefined) parts["additional_instructions"] = config.instructions;
  parts["state"] = state;
  return {
    model,
    system,
    prompt: canonicalJson(parts),
    maxOutputTokens: config.maxOutputTokens ?? ESCALATION_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/** Read an LLM reply as one value of the question's type, or null when it is not one. */
export function parseEscalationReply(question: QuestionDef, text: string): Value {
  let reply = text.trim().replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
  if (reply.length >= 2 && reply.startsWith('"') && reply.endsWith('"')) reply = reply.slice(1, -1).trim();
  return typeFor(question.type).parse(question, reply);
}
