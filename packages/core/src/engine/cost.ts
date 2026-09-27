// Cost and savings math. All money
// is integer micro-USD with one round_half_up per term. USD fields exist only on the envelope.

import type { ModelPrice } from "../contracts/ports.js";
import type { CounterfactualMode, SavingsSuppressed } from "../contracts/run.js";
import type { SavingsKind } from "../contracts/common.js";
import { roundHalfUp } from "../util/numbers.js";

/**
 * One call's cost: the provider-reported cost when the response carried usage.cost, else the price
 * book row of the call's resolved model, else null (unpriced).
 */
export function callCostMicro(
  call: { inputTokens: number; outputTokens: number; reportedMicro: number | null },
  price: ModelPrice | null,
): number | null {
  if (call.reportedMicro !== null) return call.reportedMicro;
  if (price === null) return null;
  return (
    roundHalfUp((call.inputTokens * price.inputPerMtokMicroUsd) / 1e6) +
    roundHalfUp((call.outputTokens * price.outputPerMtokMicroUsd) / 1e6)
  );
}

/** Sum of call costs; null when any call is unpriced. */
export function sumCostMicro(costs: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const c of costs) {
    if (c === null) return null;
    total += c;
  }
  return total;
}

/** counterfactual_micro = round_half_up((in x inPrice + out x outPrice) / 1e6). */
export function counterfactualMicro(inputTokens: number, outputTokens: number, price: ModelPrice | null): number {
  if (price === null) return 0;
  return roundHalfUp((inputTokens * price.inputPerMtokMicroUsd + outputTokens * price.outputPerMtokMicroUsd) / 1e6);
}

/** One counted question: its spec stage's state estimate and its own question estimate. */
export interface CountedQuestion {
  stateTokens: number;
  questionTokens: number;
}

/** cf_input_tokens for one_call (the default) or per_question. */
export function counterfactualInputTokens(
  mode: CounterfactualMode,
  counted: readonly CountedQuestion[],
  stageStateTokens: readonly number[],
): number {
  if (counted.length === 0) return 0;
  if (mode === "per_question") return counted.reduce((n, q) => n + q.stateTokens + q.questionTokens, 0);
  return Math.max(0, ...stageStateTokens) + counted.reduce((n, q) => n + q.questionTokens, 0);
}

export interface SavingsInput {
  kind: SavingsKind;
  mode: CounterfactualMode;
  /** Counted questions: relevant, auto (see run.ts for shadow runs). */
  counted: readonly CountedQuestion[];
  /** State estimates of the spec stages that ran. */
  stageStateTokens: readonly number[];
  estOutputTokensPerQuestion: number;
  comparatorPrice: ModelPrice | null;
  /** The run's System One cost; null counts as 0 here and the run carries model_unpriced. */
  systemOneCostMicro: number | null;
  escalationCostMicro: number;
  /** True when any question called the LLM. */
  escalated: boolean;
  /** The org's mean escalation cost, or null to estimate it with the comparator. */
  avgEscalationCostMicro: number | null;
  /** Relevant questions, for the escalation estimate. */
  relevant: readonly CountedQuestion[];
  tokensBefore: number | undefined;
  tokensAfter: number | undefined;
  suppressed: SavingsSuppressed | null;
}

export interface SavingsResult {
  cfInputTokens: number;
  cfOutputTokens: number;
  counterfactualMicro: number;
  /** The savings before suppression (would-be savings for suppressed runs). */
  grossSavingsMicro: number;
  /** 0 when suppressed. */
  savingsMicro: number;
  llmCallsAvoided: number;
  contextTokensPruned: number | undefined;
}

/** Savings of one run for the set's single savings kind. */
export function computeSavings(i: SavingsInput): SavingsResult {
  const cfInputTokens = counterfactualInputTokens(i.mode, i.counted, i.stageStateTokens);
  const cfOutputTokens = i.counted.length * i.estOutputTokensPerQuestion;
  const cf = counterfactualMicro(cfInputTokens, cfOutputTokens, i.comparatorPrice);
  const s1 = i.systemOneCostMicro ?? 0;
  let gross: number;
  let llmCallsAvoided: number;
  let contextTokensPruned: number | undefined;
  switch (i.kind) {
    case "decision":
      gross = cf - s1 - i.escalationCostMicro;
      llmCallsAvoided = i.mode === "per_question" ? i.counted.length : Math.min(1, i.counted.length);
      break;
    case "escalation_avoided": {
      llmCallsAvoided = i.escalated ? 0 : 1;
      const avg =
        i.avgEscalationCostMicro ??
        counterfactualMicro(
          counterfactualInputTokens("one_call", i.relevant, i.stageStateTokens),
          i.relevant.length * i.estOutputTokensPerQuestion,
          i.comparatorPrice,
        );
      // No escalation_cost term: a run that escalated already scores 0 calls avoided.
      gross = llmCallsAvoided * avg - s1;
      break;
    }
    case "context_pruned": {
      llmCallsAvoided = 0;
      contextTokensPruned =
        i.tokensBefore !== undefined && i.tokensAfter !== undefined ? Math.max(0, i.tokensBefore - i.tokensAfter) : 0;
      const priced = i.comparatorPrice === null ? 0 : roundHalfUp((contextTokensPruned * i.comparatorPrice.inputPerMtokMicroUsd) / 1e6);
      gross = priced - s1 - i.escalationCostMicro;
      break;
    }
  }
  return {
    cfInputTokens,
    cfOutputTokens,
    counterfactualMicro: cf,
    grossSavingsMicro: gross,
    savingsMicro: i.suppressed === null ? gross : 0,
    llmCallsAvoided,
    contextTokensPruned,
  };
}

/** Why a run books no savings, in the order the reasons win. */
export function savingsSuppression(i: {
  source: string;
  arm: "champion" | "challenger" | undefined;
  channel: string;
  routingStage: string;
}): SavingsSuppressed | null {
  if (i.source === "eval") return "eval";
  if (i.arm === "challenger") return "experiment";
  if (i.channel === "staging") return "staging";
  if (i.routingStage === "shadow") return "shadow";
  return null;
}
