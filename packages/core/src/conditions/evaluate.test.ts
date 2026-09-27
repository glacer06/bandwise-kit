import { describe, expect, it } from "vitest";
import type { Condition } from "../contracts/policy.js";
import { type ConditionContext, EMPTY_CONTEXT, conditionInputPaths, conditionQuestionIds, evaluateCondition } from "./evaluate.js";

const ctx: ConditionContext = {
  input: { email: { from: "bot@noreply.example.com", subject: "Re: invoice", size: 12, tags: ["a"], nothing: null } },
  checks: { is_reply: true, has_body: false },
  questions: {
    category: { type: "choice", value: "work_request", band: "high", numeric: null },
    urgent: { type: "noul", value: true, band: "medium", numeric: 0.8 },
    maybe: { type: "noul", value: null, band: "low", numeric: 0.5 },
    level: { type: "score", value: 1.6, band: "high", numeric: 1.6 },
    low_level: { type: "score", value: 1.4, band: "high", numeric: 1.4 },
  },
  composites: { urgency: 0.72, empty: null },
};

const rows: Array<[name: string, cond: Condition, expected: boolean]> = [
  ["all of nothing", { all: [] }, true],
  ["any of nothing", { any: [] }, false],
  ["not", { not: { check: "has_body" } }, true],
  ["all of two", { all: [{ check: "is_reply" }, { q: "urgent", band: "medium" }] }, true],
  ["all fails on one", { all: [{ check: "is_reply" }, { check: "has_body" }] }, false],
  ["any of two", { any: [{ check: "has_body" }, { check: "is_reply" }] }, true],
  ["check held", { check: "is_reply" }, true],
  ["unknown check", { check: "nope" }, false],
  ["choice eq", { q: "category", eq: "work_request" }, true],
  ["choice neq", { q: "category", neq: "newsletter" }, true],
  ["choice in", { q: "category", in: ["newsletter", "work_request"] }, true],
  ["band", { q: "urgent", band: "medium" }, true],
  ["noul eq true", { q: "urgent", eq: true }, true],
  ["noul low band value null", { q: "maybe", eq: null }, true],
  ["score eq rounds 1.6 to 2", { q: "level", eq: 2 }, true],
  ["score eq rounds 1.4 to 1", { q: "low_level", eq: 2 }, false],
  ["noul gte reads the noul", { q: "urgent", gte: 0.75 }, true],
  ["score lte reads the raw score", { q: "level", lte: 1.5 }, false],
  ["choice range is false", { q: "category", gte: 0 }, false],
  ["unasked question eq is false", { q: "missing", eq: true }, false],
  ["unasked question neq is false", { q: "missing", neq: true }, false],
  ["composite range", { composite: "urgency", gte: 0.7, lte: 0.8 }, true],
  ["composite below", { composite: "urgency", gte: 0.8 }, false],
  ["composite with no value", { composite: "empty", gte: 0 }, false],
  ["unknown composite", { composite: "nope", lte: 1 }, false],
  ["input eq", { input: "email.subject", eq: "Re: invoice" }, true],
  ["input neq", { input: "email.subject", neq: "x" }, true],
  ["input in", { input: "email.size", in: [12, 13] }, true],
  ["input matches", { input: "email.from", matches: "@noreply\\." }, true],
  ["input matches on a number is false", { input: "email.size", matches: "1" }, false],
  ["input range", { input: "email.size", gte: 10, lte: 12 }, true],
  ["input range on a string", { input: "email.subject", gte: 1 }, false],
  ["exists true", { input: "email.tags[0]", exists: true }, true],
  ["exists for null", { input: "email.nothing", exists: true }, true],
  ["exists false on a missing path", { input: "email.cc", exists: false }, true],
  ["missing path eq is false", { input: "email.cc", eq: null }, false],
  ["missing path neq is false", { input: "email.cc", neq: "x" }, false],
];

describe("evaluateCondition", () => {
  it.each(rows)("%s", (_name, cond, expected) => {
    expect(evaluateCondition(cond, ctx)).toBe(expected);
  });

  it("reads nothing from the empty context", () => {
    expect(evaluateCondition({ input: "a", exists: false }, EMPTY_CONTEXT)).toBe(true);
    expect(evaluateCondition({ q: "a", band: "high" }, EMPTY_CONTEXT)).toBe(false);
  });

  it("lists the questions and input paths a condition reads", () => {
    const cond: Condition = {
      all: [
        { q: "a", eq: 1 },
        { any: [{ not: { q: "b", band: "low" } }, { input: "x.y", exists: true }] },
        { check: "c" },
      ],
    };
    expect(conditionQuestionIds(cond)).toEqual(["a", "b"]);
    expect(conditionInputPaths(cond)).toEqual(["x.y"]);
  });
});
