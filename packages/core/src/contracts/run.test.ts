import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Decision, RunCost, RunResult, UsdAmount, microFromUsd, usdFromMicro } from "./run.js";

function loadSample(): unknown {
  const url = new URL("./__fixtures__/run-result.sample.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

/** A parsed sample to derive variants from. */
function sample(): RunResult {
  return RunResult.parse(loadSample());
}

describe("RunResult", () => {
  it("round-trips the hand-written sample: parse, serialize, parse again", () => {
    const first = RunResult.parse(loadSample());
    const second = RunResult.parse(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
    expect(first).toEqual(loadSample());
  });

  it("keeps unknown fields on answers (passthrough) through the round trip", () => {
    const raw = sample();
    const withExtra = { ...raw, answers: { ...raw.answers, real_person: { type: "noul", noul: 0.97, trace: "x" } } };
    const parsed = RunResult.parse(JSON.parse(JSON.stringify(withExtra)));
    expect(parsed.answers.real_person).toEqual({ type: "noul", noul: 0.97, trace: "x" });
  });

  it("strips unknown top-level keys, so an older reader accepts a newer envelope", () => {
    const parsed = RunResult.parse({ ...sample(), addedLater: 1 });
    expect(parsed).not.toHaveProperty("addedLater");
  });

  it("has no dryRun key, so RunResult | RunDryRunResult can discriminate on it", () => {
    expect(sample()).not.toHaveProperty("dryRun");
  });

  it("stores an unknown answer type raw", () => {
    const r = sample();
    const parsed = RunResult.parse({
      ...r,
      answers: { ...r.answers, mood: { type: "rank", order: ["a", "b"] } },
      warnings: ["unknown_answer_type"],
    });
    expect(parsed.answers.mood).toEqual({ type: "rank", order: ["a", "b"] });
  });

  it("rejects a known answer type that fails its own variant", () => {
    const r = sample();
    const bad = { ...r, answers: { ...r.answers, real_person: { type: "noul" } } };
    expect(RunResult.safeParse(bad).success).toBe(false);
  });

  it("accepts a run whose every stage was skipped, with a null modelResolved", () => {
    const r = sample();
    const parsed = RunResult.safeParse({
      ...r,
      modelResolved: null,
      typesafeRequestId: null,
      stages: [{ id: "triage", skipped: true, calls: [] }],
      answers: {},
      cost: { ...r.cost, systemOneInputTokens: 0, systemOneOutputTokens: 0, systemOneCostUsd: 0 },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-null modelResolved when no call was made", () => {
    const r = sample();
    const parsed = RunResult.safeParse({
      ...r,
      stages: [{ id: "triage", skipped: true, calls: [] }],
      cost: { ...r.cost, systemOneInputTokens: 0, systemOneOutputTokens: 0 },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a modelResolved that is not the first call's", () => {
    expect(RunResult.safeParse({ ...sample(), modelResolved: "jev-1.14.0" }).success).toBe(false);
  });

  it("accepts calls that resolved to different models (warning model_resolved_mixed)", () => {
    const r = sample();
    const call = { modelResolved: "jev-1.14.0", typesafeRequestId: null, inputTokens: 100, outputTokens: 0, latencyMs: 300 };
    const stage0 = r.stages[0];
    if (stage0 === undefined) throw new Error("sample has a stage");
    const parsed = RunResult.safeParse({
      ...r,
      stages: [{ ...stage0, calls: [...stage0.calls, call] }],
      cost: { ...r.cost, systemOneInputTokens: 418 },
      warnings: ["model_resolved_mixed"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects token totals that are not the sum over calls", () => {
    const r = sample();
    expect(RunResult.safeParse({ ...r, cost: { ...r.cost, systemOneInputTokens: 319 } }).success).toBe(false);
    expect(RunResult.safeParse({ ...r, cost: { ...r.cost, systemOneOutputTokens: 1 } }).success).toBe(false);
  });

  it("rejects a skipped stage that made a call", () => {
    const r = sample();
    const stage0 = r.stages[0];
    if (stage0 === undefined) throw new Error("sample has a stage");
    expect(RunResult.safeParse({ ...r, stages: [{ ...stage0, skipped: true }] }).success).toBe(false);
  });

  it("requires savingsUsd 0 when savings are suppressed", () => {
    const r = sample();
    const shadow = { ...r, rollout: "shadow", cost: { ...r.cost, savingsSuppressed: "shadow" } };
    expect(RunResult.safeParse(shadow).success).toBe(false);
    expect(RunResult.safeParse({ ...shadow, cost: { ...shadow.cost, savingsUsd: 0 } }).success).toBe(true);
  });

  it("suppresses savings for an outage run", () => {
    const r = sample();
    const outage = {
      ...r,
      status: "error",
      error: { code: "system_one_unavailable", message: "System One did not answer in time." },
      cost: { ...r.cost, savingsSuppressed: "outage", savingsUsd: 0 },
    };
    expect(RunResult.safeParse(outage).success).toBe(true);
    expect(RunResult.safeParse({ ...outage, cost: { ...outage.cost, savingsUsd: 0.001 } }).success).toBe(false);
  });

  it("accepts an experiment arm and rejects an unknown one", () => {
    const r = sample();
    const experiment = { id: "01923f40-3333-7aaa-9bbb-000000000001", arm: "challenger" };
    expect(RunResult.safeParse({ ...r, experiment }).success).toBe(true);
    expect(RunResult.safeParse({ ...r, experiment: { ...experiment, arm: "canary" } }).success).toBe(false);
  });

  it("rejects unknown enum values for channel, rollout, status and overallAction", () => {
    const r = sample();
    expect(RunResult.safeParse({ ...r, channel: "canary" }).success).toBe(false);
    expect(RunResult.safeParse({ ...r, rollout: "live" }).success).toBe(false);
    expect(RunResult.safeParse({ ...r, status: "failed" }).success).toBe(false);
    expect(RunResult.safeParse({ ...r, overallAction: "skip" }).success).toBe(false);
  });

  it("rejects a decision id that breaks the id pattern", () => {
    const r = sample();
    const decision = r.decisions.real_person;
    expect(RunResult.safeParse({ ...r, decisions: { ...r.decisions, "Real-Person": decision } }).success).toBe(false);
  });
});

describe("Decision", () => {
  it("accepts a skipped question", () => {
    const skipped = {
      kind: "question",
      value: null,
      band: "low",
      relevant: false,
      action: "fallback",
      effectiveAction: "fallback",
      executed: false,
    };
    expect(Decision.safeParse(skipped).success).toBe(true);
  });

  it("accepts a composite with no term left, with level omitted", () => {
    const empty = {
      kind: "composite",
      value: null,
      band: "low",
      relevant: false,
      action: "fallback",
      effectiveAction: "fallback",
      executed: false,
    };
    expect(Decision.parse(empty)).not.toHaveProperty("level");
  });

  it("rejects a level on a question decision", () => {
    const d = { kind: "question", value: true, band: "high", level: "high", relevant: true, action: "auto", effectiveAction: "auto", executed: true };
    expect(Decision.safeParse(d).success).toBe(false);
  });

  it("rejects an irrelevant decision whose effectiveAction is not fallback", () => {
    const d = { kind: "question", value: true, band: "high", relevant: false, action: "auto", effectiveAction: "auto", executed: false };
    expect(Decision.safeParse(d).success).toBe(false);
  });

  it("carries a failed escalation, with effectiveAction review", () => {
    const d = {
      kind: "question",
      value: "work_request",
      band: "low",
      relevant: true,
      action: "escalate_to_llm",
      effectiveAction: "review",
      executed: true,
      escalation: { model: "claude-haiku-4-5", value: null, costUsd: 0, status: "failed", error: "timeout" },
    };
    expect(Decision.parse(d).escalation?.status).toBe("failed");
  });

  it("keeps fallbackRunId from a set fallback through a round trip", () => {
    const d = {
      kind: "question",
      value: "work_request",
      band: "low",
      relevant: true,
      action: "fallback",
      effectiveAction: "fallback",
      executed: true,
      fallbackRunId: "01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e99",
    };
    const first = Decision.parse(d);
    expect(first.fallbackRunId).toBe(d.fallbackRunId);
    expect(Decision.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(Decision.safeParse({ ...d, fallbackRunId: "run-1" }).success).toBe(false);
  });

  it("keeps fallbackRunId inside a RunResult round trip", () => {
    const raw = sample();
    const category = raw.decisions.category;
    if (category === undefined) throw new Error("sample has no category decision");
    const withLinked = {
      ...raw,
      decisions: { ...raw.decisions, category: { ...category, fallbackRunId: "01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e99" } },
    };
    const parsed = RunResult.parse(JSON.parse(JSON.stringify(withLinked)));
    expect(parsed.decisions.category?.fallbackRunId).toBe("01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e99");
  });
});

describe("RunResult error", () => {
  it("is absent on an ok run and required on a failed one", () => {
    const ok = sample();
    expect(RunResult.safeParse({ ...ok, error: { code: "system_one_unavailable", message: "x" } }).success).toBe(false);
    const failed = { ...ok, status: "error", error: { code: "system_one_unavailable", message: "The latency budget ran out." } };
    expect(RunResult.parse(failed).error?.code).toBe("system_one_unavailable");
    expect(RunResult.safeParse({ ...ok, status: "error" }).success).toBe(false);
    expect(RunResult.safeParse({ ...failed, error: { code: "client_aborted", message: "x" } }).success).toBe(false);
  });
});

describe("RunCost money fields", () => {
  it("matches the documented worked example", () => {
    // 318 input tokens on jev-1.13.0 at 42,000 micro-USD per Mtok cost 13 micro-USD.
    expect(Math.floor((318 * 42_000 + 500_000) / 1_000_000)).toBe(13);
    expect(usdFromMicro(905)).toBe(0.000905);
    expect(microFromUsd(0.000905)).toBe(905);
  });

  it("round-trips every micro-USD integer in a wide range through USD", () => {
    for (const micro of [-1_000_001, -905, -1, 0, 1, 13, 918, 1_234_567, 987_654_321]) {
      const usd = usdFromMicro(micro);
      expect(UsdAmount.safeParse(usd).success).toBe(true);
      expect(microFromUsd(usd)).toBe(micro);
    }
  });

  it("rejects USD amounts that are not whole micro-USD", () => {
    expect(UsdAmount.safeParse(0.0000005).success).toBe(false);
    expect(UsdAmount.safeParse(Number.NaN).success).toBe(false);
    expect(UsdAmount.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("allows negative savings and a null System One cost", () => {
    const cost = sample().cost;
    expect(RunCost.safeParse({ ...cost, savingsUsd: -0.000013, systemOneCostUsd: null }).success).toBe(true);
  });

  it("requires estimated to be true and token counts to be non-negative integers", () => {
    const cost = sample().cost;
    expect(RunCost.safeParse({ ...cost, estimated: false }).success).toBe(false);
    expect(RunCost.safeParse({ ...cost, counterfactualInputTokens: -1 }).success).toBe(false);
    expect(RunCost.safeParse({ ...cost, counterfactualOutputTokens: 1.5 }).success).toBe(false);
  });
});
