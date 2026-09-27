import { describe, expect, it } from "vitest";
import { usdFromMicro } from "../contracts/run.js";
import { callBudget } from "./budget.js";
import {
  type SavingsInput,
  callCostMicro,
  computeSavings,
  counterfactualInputTokens,
  counterfactualMicro,
  savingsSuppression,
  sumCostMicro,
} from "./cost.js";

const JEV = { inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 };
const HAIKU = { inputPerMtokMicroUsd: 1_000_000, outputPerMtokMicroUsd: 5_000_000 };

describe("money math", () => {
  it("318 input tokens on jev-1.13.0 cost 13 micro-USD", () => {
    expect(callCostMicro({ inputTokens: 318, outputTokens: 34, reportedMicro: null }, JEV)).toBe(13);
  });

  it("a provider-reported cost wins over the price book", () => {
    expect(callCostMicro({ inputTokens: 476, outputTokens: 70, reportedMicro: 20 }, JEV)).toBe(20);
    expect(callCostMicro({ inputTokens: 476, outputTokens: 70, reportedMicro: 20 }, null)).toBe(20);
  });

  it("an unpriced call is null, and so is any sum that holds one", () => {
    expect(callCostMicro({ inputTokens: 1, outputTokens: 1, reportedMicro: null }, null)).toBeNull();
    expect(sumCostMicro([13, 7])).toBe(20);
    expect(sumCostMicro([13, null])).toBeNull();
    expect(sumCostMicro([])).toBe(0);
  });

  it("counterfactual 318 in and 120 out against Haiku 4.5 is 918, savings 905", () => {
    expect(counterfactualMicro(318, 120, HAIKU)).toBe(918);
    expect(counterfactualMicro(318, 120, null)).toBe(0);
    const r = computeSavings(base({ counted: [{ stateTokens: 300, questionTokens: 9 }, { stateTokens: 300, questionTokens: 9 }], stageStateTokens: [300] }));
    expect(r.cfInputTokens).toBe(318);
    expect(r.cfOutputTokens).toBe(120);
    expect(r.counterfactualMicro).toBe(918);
    expect(r.savingsMicro).toBe(905);
    expect(usdFromMicro(r.savingsMicro)).toBe(0.000905);
    expect(r.llmCallsAvoided).toBe(1);
  });

  it("rounds half up: 0.5 micro-USD becomes 1", () => {
    const a = callCostMicro({ inputTokens: 250, outputTokens: 0, reportedMicro: null }, { inputPerMtokMicroUsd: 2_000, outputPerMtokMicroUsd: 0 });
    expect(a).toBe(1); // 0.5 rounds half up
  });
});

function base(over: Partial<SavingsInput> = {}): SavingsInput {
  return {
    kind: "decision",
    mode: "one_call",
    counted: [],
    stageStateTokens: [],
    estOutputTokensPerQuestion: 60,
    comparatorPrice: HAIKU,
    systemOneCostMicro: 13,
    escalationCostMicro: 0,
    escalated: false,
    avgEscalationCostMicro: null,
    relevant: [],
    tokensBefore: undefined,
    tokensAfter: undefined,
    suppressed: null,
    ...over,
  };
}

describe("counterfactual input tokens", () => {
  const counted = [
    { stateTokens: 100, questionTokens: 10 },
    { stateTokens: 200, questionTokens: 20 },
  ];
  it("one_call: the largest stage state plus every counted question", () => {
    expect(counterfactualInputTokens("one_call", counted, [100, 200])).toBe(230);
  });
  it("per_question: each question with its own stage state", () => {
    expect(counterfactualInputTokens("per_question", counted, [100, 200])).toBe(330);
  });
  it("is 0 with nothing counted", () => {
    expect(counterfactualInputTokens("one_call", [], [100])).toBe(0);
  });
});

describe("the three savings kinds", () => {
  it("decision with n = 0 is minus the run's cost", () => {
    const r = computeSavings(base({ escalationCostMicro: 5 }));
    expect(r.counterfactualMicro).toBe(0);
    expect(r.savingsMicro).toBe(-18);
    expect(r.llmCallsAvoided).toBe(0);
  });

  it("decision per_question counts one avoided call per counted question", () => {
    const r = computeSavings(base({ mode: "per_question", counted: [{ stateTokens: 1, questionTokens: 1 }, { stateTokens: 1, questionTokens: 1 }] }));
    expect(r.llmCallsAvoided).toBe(2);
  });

  it("escalation_avoided uses the org's mean escalation cost and no escalation term", () => {
    const r = computeSavings(base({ kind: "escalation_avoided", avgEscalationCostMicro: 500, escalationCostMicro: 999 }));
    expect(r.llmCallsAvoided).toBe(1);
    expect(r.savingsMicro).toBe(500 - 13);
    const escalated = computeSavings(base({ kind: "escalation_avoided", avgEscalationCostMicro: 500, escalated: true }));
    expect(escalated.llmCallsAvoided).toBe(0);
    expect(escalated.savingsMicro).toBe(-13);
  });

  it("escalation_avoided estimates the mean with the comparator when the org has none", () => {
    const r = computeSavings(base({ kind: "escalation_avoided", relevant: [{ stateTokens: 300, questionTokens: 18 }], stageStateTokens: [300] }));
    // 318 in, 60 out on Haiku: 318 + 300 = 618 micro.
    expect(r.savingsMicro).toBe(618 - 13);
  });

  it("context_pruned prices the pruned tokens on the downstream model", () => {
    const r = computeSavings(base({ kind: "context_pruned", tokensBefore: 10_000, tokensAfter: 4_000 }));
    expect(r.contextTokensPruned).toBe(6_000);
    expect(r.savingsMicro).toBe(6_000 - 13);
    const missing = computeSavings(base({ kind: "context_pruned", comparatorPrice: null }));
    expect(missing.contextTokensPruned).toBe(0);
    expect(missing.savingsMicro).toBe(-13);
  });

  it("an unpriced System One cost counts as 0", () => {
    expect(computeSavings(base({ systemOneCostMicro: null })).savingsMicro).toBe(0);
  });

  it("suppressed runs book 0 but keep their would-be savings", () => {
    const r = computeSavings(base({ counted: [{ stateTokens: 300, questionTokens: 18 }], stageStateTokens: [300], suppressed: "shadow" }));
    expect(r.savingsMicro).toBe(0);
    expect(r.grossSavingsMicro).toBeGreaterThan(0);
  });
});

describe("savingsSuppression", () => {
  it.each([
    [{ source: "eval", arm: "challenger", channel: "staging", routingStage: "shadow" }, "eval"],
    [{ source: "api", arm: "challenger", channel: "staging", routingStage: "shadow" }, "experiment"],
    [{ source: "api", arm: "champion", channel: "staging", routingStage: "shadow" }, "staging"],
    [{ source: "api", arm: undefined, channel: "production", routingStage: "shadow" }, "shadow"],
    [{ source: "api", arm: undefined, channel: "production", routingStage: "full" }, null],
  ] as const)("%j -> %s", (input, expected) => {
    expect(savingsSuppression(input)).toBe(expected);
  });
});

describe("callBudget", () => {
  it.each([
    [8_000, 2, 2_666, 4_000],
    [2_000, 1, 1_000, 1_000],
    [900, 0, 900, 450],
    [-5, 0, 1, 0],
  ])("%i ms left: %i retries, %i ms per attempt, retry-after up to %i", (left, retries, attempt, after) => {
    expect(callBudget(left)).toEqual({ timeoutMs: attempt, retry: { maxRetries: retries, maxRetryAfterMs: after } });
  });
});
