import { describe, expect, it } from "vitest";

import {
  ACTION_CONSERVATIVE_ORDER,
  Action,
  Channel,
  DecisionId,
  IsoTimestamp,
  JsonValue,
  MicroUsd,
  PlanId,
  QuestionId,
  RolloutStage,
  Scope,
  Structured,
  Uuid,
  mostConservativeAction,
  pageOf,
} from "./common.js";

describe("ids", () => {
  it("accepts question ids that match ^[a-z][a-z0-9_]{0,63}$", () => {
    expect(QuestionId.safeParse("real_person").success).toBe(true);
    expect(QuestionId.safeParse("a").success).toBe(true);
    expect(QuestionId.safeParse(`a${"b".repeat(63)}`).success).toBe(true);
  });

  it("rejects question ids that break the pattern", () => {
    for (const bad of ["", "Real", "1abc", "_a", "a-b", "a.b", `a${"b".repeat(64)}`]) {
      expect(QuestionId.safeParse(bad).success).toBe(false);
      expect(DecisionId.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts a uuidv7 and rejects other strings", () => {
    expect(Uuid.safeParse("01923f4e-7b2a-7c3d-8e4f-5a6b7c8d9e0f").success).toBe(true);
    expect(Uuid.safeParse("set_123").success).toBe(false);
  });

  it("checks plan ids", () => {
    expect(PlanId.safeParse("team").success).toBe(true);
    expect(PlanId.safeParse("Team").success).toBe(false);
    expect(PlanId.safeParse(`p${"x".repeat(32)}`).success).toBe(false);
  });
});

describe("money and time", () => {
  it("MicroUsd is a safe integer and may be negative", () => {
    expect(MicroUsd.safeParse(-905).success).toBe(true);
    expect(MicroUsd.safeParse(0.5).success).toBe(false);
    expect(MicroUsd.safeParse(2 ** 53).success).toBe(false);
  });

  it("IsoTimestamp accepts UTC and offsets, rejects dates without time", () => {
    expect(IsoTimestamp.safeParse("2026-09-26T12:00:00Z").success).toBe(true);
    expect(IsoTimestamp.safeParse("2026-09-26T12:00:00.123+00:00").success).toBe(true);
    expect(IsoTimestamp.safeParse("2026-09-26").success).toBe(false);
  });
});

describe("JSON and Structured", () => {
  it("accepts JSON values and rejects functions and undefined", () => {
    expect(JsonValue.safeParse({ a: [1, "x", null, { b: true }] }).success).toBe(true);
    expect(JsonValue.safeParse(() => 1).success).toBe(false);
    expect(JsonValue.safeParse(undefined).success).toBe(false);
  });

  it("Structured is a string, an object or an array, not a bare number", () => {
    expect(Structured.safeParse("Is this urgent?").success).toBe(true);
    expect(Structured.safeParse({ true: "yes", false: "no" }).success).toBe(true);
    expect(Structured.safeParse(["low", "high"]).success).toBe(true);
    expect(Structured.safeParse(3).success).toBe(false);
    expect(Structured.safeParse(null).success).toBe(false);
  });
});

describe("unions", () => {
  it("has the documented channel, rollout and scope values", () => {
    expect(Channel.options).toEqual(["production", "staging", "pinned", "draft"]);
    expect(RolloutStage.options).toEqual(["inactive", "shadow", "controlled", "full", "paused"]);
    expect(Scope.options).toHaveLength(17);
  });
});

describe("conservative action order", () => {
  it("is review > fallback > escalate_to_llm > auto", () => {
    expect(ACTION_CONSERVATIVE_ORDER).toEqual(["review", "fallback", "escalate_to_llm", "auto"]);
    expect([...ACTION_CONSERVATIVE_ORDER].sort()).toEqual([...Action.options].sort());
  });

  it("picks the most conservative action, and fallback for none", () => {
    expect(mostConservativeAction(["auto", "escalate_to_llm"])).toBe("escalate_to_llm");
    expect(mostConservativeAction(["auto", "fallback", "escalate_to_llm"])).toBe("fallback");
    expect(mostConservativeAction(["fallback", "review", "auto"])).toBe("review");
    expect(mostConservativeAction(["auto"])).toBe("auto");
    expect(mostConservativeAction([])).toBe("fallback");
  });
});

describe("pageOf", () => {
  it("builds { data, nextCursor }", () => {
    const page = pageOf(QuestionId);
    expect(page.safeParse({ data: ["a"], nextCursor: null }).success).toBe(true);
    expect(page.safeParse({ data: ["A"], nextCursor: null }).success).toBe(false);
    expect(page.safeParse({ data: [] }).success).toBe(false);
  });
});
