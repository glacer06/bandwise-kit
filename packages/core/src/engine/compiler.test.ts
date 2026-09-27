import { describe, expect, it } from "vitest";
import { SystemOneRequest } from "../contracts/system-one.js";
import { SEED_MODEL_PROFILES, SEED_MODEL_ROUTES } from "../models/catalog.js";
import { effectiveLimits } from "../contracts/models.js";
import { exampleSpec } from "../test/harness.js";
import { estimateTokens } from "../util/tokens.js";
import { compileRequest, compileStage, compileStageQuestions } from "./compiler.js";
import { PREFLIGHT_WARNINGS, REQUEST_OVERHEAD_TOKENS, preflightStage, questionTokens } from "./preflight.js";

describe("spec compiler", () => {
  it("compiles every example question into a valid System One request", () => {
    const spec = exampleSpec();
    const stage = spec.stages[0];
    if (stage === undefined) throw new Error("no stage");
    const req = compileStage(stage, { email: {} }, "jev-1.13.0");
    expect(SystemOneRequest.parse(req)).toEqual(req);
    expect(Object.keys(req.questions)).toEqual(["real_person", "someone_waiting", "cost_of_ignoring", "category", "work_type"]);
    expect(req.questions["category"]).toEqual({
      type: "choice",
      instructions: stage.questions["category"]?.instructions,
      criteria: stage.questions["category"]?.criteria,
    });
    // meta never reaches the API.
    expect(JSON.stringify(req)).not.toContain("Real person wrote it");
  });

  it("sends the provider's model id as given", () => {
    const req = compileRequest({ a: { type: "noul", instructions: "x" } }, "state", "typesafe/jev-1.13");
    expect(req.model).toBe("typesafe/jev-1.13");
    expect(req.state).toBe("state");
  });

  it("keeps question order", () => {
    const qs = compileStageQuestions({
      questions: {
        z: { type: "noul", instructions: "z", meta: { label: "z" } },
        a: { type: "noul", instructions: "a", meta: { label: "a" } },
      },
    });
    expect(Object.keys(qs)).toEqual(["z", "a"]);
  });
});

const jev = SEED_MODEL_PROFILES.find((p) => p.id === "jev-1.13.0");
const jevLimits = jev?.limits ?? null;
if (jevLimits === null) throw new Error("seed profile has no limits");
const openRouterLimits = effectiveLimits(jevLimits, SEED_MODEL_ROUTES[0]?.limits ?? null);
if (openRouterLimits === null) throw new Error("no OpenRouter limits");

/** A state of roughly `tokens` estimated tokens. */
const stateOf = (tokens: number): string => "x".repeat(tokens * 4);

describe("preflight", () => {
  const q = { type: "noul" as const, instructions: "Is this urgent?" };

  it("reads limits from the profile: a fake 16k profile blocks a 20k state that jev-1.13.0 lets through", () => {
    const fake = { requestTokens: 16_000, statePlusLongestQuestionTokens: 16_000 };
    const blocked = preflightStage({ q }, stateOf(20_000), "fake-1.0.0", fake);
    expect(blocked.ok).toBe(false);
    const allowed = preflightStage({ q }, stateOf(20_000), "jev-1.13.0", jevLimits);
    expect(allowed.ok).toBe(true);
  });

  it("jev-1.13.0 on OpenRouter blocks a request over 32,000 tokens that TypeSafe direct accepts", () => {
    const state = stateOf(31_980);
    const typesafe = preflightStage({ q }, state, "jev-1.13.0", jevLimits);
    const openrouter = preflightStage({ q }, state, "typesafe/jev-1.13", openRouterLimits);
    expect(typesafe.ok).toBe(true);
    expect(openrouter.ok).toBe(false);
    if (typesafe.ok) expect(typesafe.batches[0]?.estTokens).toBeGreaterThan(32_000);
  });

  it("blocks state plus the longest question over its limit", () => {
    const res = preflightStage({ q }, stateOf(32_000), "jev-1.13.0", jevLimits);
    expect(res).toMatchObject({ ok: false });
  });

  it("blocks a state over input.maxStateTokens", () => {
    const res = preflightStage({ q }, stateOf(500), "jev-1.13.0", jevLimits, 100);
    expect(res.ok).toBe(false);
  });

  it("splits a stage into parallel batches when one request is too big", () => {
    const big = { type: "noul" as const, instructions: "y".repeat(4 * 3_000) };
    const limits = { requestTokens: 8_000, statePlusLongestQuestionTokens: 8_000 };
    const res = preflightStage({ a: big, b: big, c: big }, stateOf(1_000), "m", limits);
    if (!res.ok) throw new Error(res.message);
    expect(res.batches.map((b) => b.questionIds)).toEqual([["a", "b"], ["c"]]);
    for (const b of res.batches) {
      expect(b.estTokens).toBeLessThanOrEqual(limits.requestTokens);
      expect(Object.keys(b.request.questions)).toEqual(b.questionIds);
    }
    expect(res.warnings).toEqual([PREFLIGHT_WARNINGS.nearLimit]);
  });

  it("warns at 80 percent of a limit and not below", () => {
    const limits = { requestTokens: 1_000, statePlusLongestQuestionTokens: 1_000 };
    const near = preflightStage({ q }, stateOf(850), "m", limits);
    const far = preflightStage({ q }, stateOf(100), "m", limits);
    expect(near.ok && near.warnings).toEqual([PREFLIGHT_WARNINGS.nearLimit]);
    expect(far.ok && far.warnings).toEqual([]);
  });

  it("estimates a batch as state plus overhead plus its questions", () => {
    const res = preflightStage({ q }, "hello", "m", jevLimits);
    if (!res.ok) throw new Error(res.message);
    expect(res.stateTokens).toBe(estimateTokens("hello"));
    expect(res.batches[0]?.estTokens).toBe(res.stateTokens + REQUEST_OVERHEAD_TOKENS + questionTokens("q", q));
  });
});
