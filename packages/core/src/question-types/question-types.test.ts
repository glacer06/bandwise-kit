import { describe, expect, it } from "vitest";
import type { ChoicePolicy, NoulPolicy, ScorePolicy } from "../contracts/policy.js";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "../contracts/question-types.js";
import type { ChoiceAnswer, ScoreAnswer } from "../contracts/system-one.js";
import { compileQuestion, hasNoneOption, moduleFor, parseAnswerFor, questionTypes, scoreLevels } from "./index.js";

const actions = { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } as const;

const noulPolicy: NoulPolicy = {
  type: "noul",
  gating: true,
  noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
  actions,
};

describe("noul band edges", () => {
  const rows: Array<[noul: number, value: boolean | null, band: string]> = [
    [1, true, "high"],
    [0.85, true, "high"], // exactly trueAt
    [0.8499, true, "medium"], // just below trueAt, inside the margin
    [0.75, true, "medium"], // exactly trueAt - reviewMargin
    [0.7499, null, "low"],
    [0.5, null, "low"], // near 0.5 is uncertainty, not a medium yes
    [0.2501, null, "low"],
    [0.25, false, "medium"], // exactly falseAt + reviewMargin
    [0.1501, false, "medium"],
    [0.15, false, "high"], // exactly falseAt
    [0, false, "high"],
  ];
  it.each(rows)("noul %f is %s in band %s", (noul, value, band) => {
    expect(questionTypes.noul.band({ type: "noul", noul }, noulPolicy)).toEqual({ value, band });
  });
});

const choicePolicy: ChoicePolicy = {
  type: "choice",
  gating: true,
  thresholds: { high: 0.75, medium: 0.45 },
  perOption: { refund: { high: 0.9, medium: 0.7 } },
  actions,
};

const choice = (c: string, confidence: number): ChoiceAnswer => ({
  type: "choice",
  choice: c,
  confidence,
  probabilities: { billing: 0.6, refund: 0.3, none: 0.1 },
});

describe("choice band edges", () => {
  const rows: Array<[option: string, confidence: number, band: string]> = [
    ["billing", 0.75, "high"],
    ["billing", 0.7499, "medium"],
    ["billing", 0.45, "medium"],
    ["billing", 0.4499, "low"],
    ["refund", 0.9, "high"], // per-option override
    ["refund", 0.89, "medium"],
    ["refund", 0.7, "medium"],
    ["refund", 0.69, "low"],
  ];
  it.each(rows)("%s at %f is %s", (option, confidence, band) => {
    expect(questionTypes.choice.band(choice(option, confidence), choicePolicy)).toEqual({ value: option, band });
  });

  it("uses the base thresholds without perOption", () => {
    const { perOption: _p, ...plain } = choicePolicy;
    expect(questionTypes.choice.band(choice("refund", 0.8), plain).band).toBe("high");
  });

  it("composite value is the named option's probability", () => {
    expect(questionTypes.choice.compositeValue?.(choice("billing", 0.9), { q: "c", weight: 1, option: "refund" })).toBe(0.3);
    expect(questionTypes.choice.compositeValue?.(choice("billing", 0.9), { q: "c", weight: 1, option: "missing" })).toBe(0);
    expect(questionTypes.choice.compositeValue?.(choice("billing", 0.9), { q: "c", weight: 1 })).toBe(0);
  });
});

const scorePolicy: ScorePolicy = { type: "score", gating: true, thresholds: { high: 0.75, medium: 0.45 }, actions };
const score = (s: number, confidence: number, levels = 4): ScoreAnswer => ({
  type: "score",
  score: s,
  confidence,
  legend: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), `level ${i}`])),
  probabilities: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), 1 / levels])),
});

describe("score band edges", () => {
  const rows: Array<[confidence: number, band: string]> = [
    [0.75, "high"],
    [0.7499, "medium"],
    [0.45, "medium"],
    [0.4499, "low"],
  ];
  it.each(rows)("confidence %f is %s, value is the raw score", (confidence, band) => {
    expect(questionTypes.score.band(score(1.05, confidence), scorePolicy)).toEqual({ value: 1.05, band });
  });

  it("composite value is score / (levels - 1), clamped", () => {
    expect(questionTypes.score.compositeValue?.(score(1.5, 0.9), { q: "s", weight: 1 })).toBe(0.5);
    expect(questionTypes.score.compositeValue?.(score(9, 0.9), { q: "s", weight: 1 })).toBe(1);
    expect(questionTypes.score.compositeValue?.(score(0, 0.9, 1), { q: "s", weight: 1 })).toBe(0);
    expect(scoreLevels(score(1, 1, 5))).toBe(5);
  });
});

describe("noul composite value", () => {
  it("is the noul, clamped to 0..1", () => {
    expect(questionTypes.noul.compositeValue?.({ type: "noul", noul: 0.3 }, { q: "n", weight: 1 })).toBe(0.3);
    expect(questionTypes.noul.compositeValue?.({ type: "noul", noul: 1.2 }, { q: "n", weight: 1 })).toBe(1);
  });
});

describe("compile", () => {
  it("noul keeps instructions and drops undefined criteria keys", () => {
    const q: NoulQuestion = { type: "noul", instructions: "Is `email` spam?", criteria: { true: "Spam", false: undefined } as unknown as NoulQuestion["criteria"], meta: { label: "Spam" } };
    expect(compileQuestion(q)).toEqual({ type: "noul", instructions: "Is `email` spam?", criteria: { true: "Spam" } });
    const bare: NoulQuestion = { type: "noul", instructions: { question: "Spam?" }, meta: { label: "Spam" } };
    expect(compileQuestion(bare)).toEqual({ type: "noul", instructions: { question: "Spam?" } });
  });

  it("choice and score keep criteria as written, without meta", () => {
    const c: ChoiceQuestion = { type: "choice", instructions: "Which?", criteria: { a: "A", none: null }, meta: { label: "C" } };
    expect(compileQuestion(c)).toEqual({ type: "choice", instructions: "Which?", criteria: { a: "A", none: null } });
    const s: ScoreQuestion = { type: "score", instructions: "How?", criteria: ["low", { level: "high" }], meta: { label: "S" } };
    expect(compileQuestion(s)).toEqual({ type: "score", instructions: "How?", criteria: ["low", { level: "high" }] });
  });
});

describe("module metadata", () => {
  it("has one module per v1 type with its ui kind", () => {
    expect(Object.keys(questionTypes)).toEqual(["noul", "choice", "score"]);
    expect(moduleFor("noul").uiKind).toBe("boolean");
    expect(moduleFor("choice").uiKind).toBe("options");
    expect(moduleFor("score").uiKind).toBe("scale");
  });

  it("manifest hints carry label, description, options and levels", () => {
    expect(questionTypes.noul.manifestHint({ type: "noul", instructions: "x", meta: { label: "N", description: "d" } })).toEqual({
      type: "noul",
      label: "N",
      description: "d",
    });
    expect(questionTypes.choice.manifestHint({ type: "choice", instructions: "x", criteria: { a: null, b: null }, meta: { label: "C" } })).toEqual({
      type: "choice",
      label: "C",
      options: ["a", "b"],
    });
    expect(questionTypes.score.manifestHint({ type: "score", instructions: "x", criteria: ["a", "b", "c"], meta: { label: "S" } })).toEqual({
      type: "score",
      label: "S",
      levels: 3,
    });
  });

  it("parses answers with the asked type's schema", () => {
    expect(parseAnswerFor("noul", { type: "noul", noul: 0.4, extra: 1 })).toEqual({ type: "noul", noul: 0.4, extra: 1 });
    expect(parseAnswerFor("noul", { type: "choice", choice: "a" })).toBeNull();
  });

  it("recognizes none-style options", () => {
    expect(hasNoneOption(["billing", "none_of_these"])).toBe(true);
    expect(hasNoneOption(["billing", "Other"])).toBe(true);
    expect(hasNoneOption(["billing", "noneish"])).toBe(false);
  });
});

describe("type lints", () => {
  const at = { questionId: "q", path: "/stages/0/questions/q" };
  it("choice.missing_none and choice.too_many_options", () => {
    const [lint] = questionTypes.choice.lints;
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    const results = lint?.({ type: "choice", instructions: "x", criteria: many, meta: { label: "C" } }, at) ?? [];
    expect(results.map((r) => r.rule)).toEqual(["choice.missing_none", "choice.too_many_options"]);
    expect(lint?.({ type: "choice", instructions: "x", criteria: { a: null, none: null }, meta: { label: "C" } }, at)).toEqual([]);
  });

  it("score.levels_range", () => {
    const [lint] = questionTypes.score.lints;
    expect(lint?.({ type: "score", instructions: "x", criteria: ["one"], meta: { label: "S" } }, at).map((r) => r.rule)).toEqual(["score.levels_range"]);
    expect(lint?.({ type: "score", instructions: "x", criteria: Array.from({ length: 11 }, () => "l"), meta: { label: "S" } }, at)).toHaveLength(1);
    expect(lint?.({ type: "score", instructions: "x", criteria: ["a", "b"], meta: { label: "S" } }, at)).toEqual([]);
  });
});
