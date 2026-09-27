import { describe, expect, expectTypeOf, it } from "vitest";
import {
  NoulQuestion,
  QUESTION_TYPE_IDS,
  QuestionDef,
  QuestionTypeId,
  type AnswerOf,
  type ChoiceTypeModule,
  type NoulTypeModule,
  type PolicyOf,
  type QuestionOf,
  type QuestionTypeModules,
  isQuestionTypeId,
} from "./question-types.js";
import { NoulAnswer, type SystemOneQuestion } from "./system-one.js";

const meta = { label: "Label" };

describe("QuestionDef", () => {
  it("parses one variant per type", () => {
    const defs: unknown[] = [
      { type: "noul", instructions: "Is `email` spam?", meta },
      { type: "noul", instructions: "Is `email` spam?", criteria: { true: "Spam", false: "Not spam" }, meta },
      { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", other: null }, meta },
      { type: "score", instructions: "How urgent?", criteria: ["Low", "High"], meta },
      { type: "score", instructions: { question: "How urgent?", ticket: "`ticket`" }, criteria: [{ level: "Low" }, "High"], meta },
    ];
    for (const d of defs) expect(QuestionDef.safeParse(d).success, JSON.stringify(d)).toBe(true);
  });

  it("requires criteria for choice and score", () => {
    expect(QuestionDef.safeParse({ type: "choice", instructions: "Which?", meta }).success).toBe(false);
    expect(QuestionDef.safeParse({ type: "choice", instructions: "Which?", criteria: {}, meta }).success).toBe(false);
    expect(QuestionDef.safeParse({ type: "score", instructions: "How?", meta }).success).toBe(false);
    expect(QuestionDef.safeParse({ type: "score", instructions: "How?", criteria: { "0": "Low" }, meta }).success).toBe(
      false,
    );
  });

  it("requires meta with a label", () => {
    expect(QuestionDef.safeParse({ type: "noul", instructions: "Is it?" }).success).toBe(false);
    expect(QuestionDef.safeParse({ type: "noul", instructions: "Is it?", meta: {} }).success).toBe(false);
  });

  it("is strict at the question level and open inside meta and criteria", () => {
    expect(QuestionDef.safeParse({ type: "noul", instructions: "Is it?", meta, weight: 1 }).success).toBe(false);
    const open = {
      type: "noul",
      instructions: "Is it?",
      criteria: { true: "Yes", false: "No", examples: ["a"] },
      meta: { label: "L", templateId: "tpl_1", owner: "ops" },
    };
    expect(NoulQuestion.parse(open)).toEqual(open);
  });

  it("rejects question types outside the closed v1 union", () => {
    expect(QuestionDef.safeParse({ type: "rank", instructions: "Order these", meta }).success).toBe(false);
  });
});

describe("question type ids", () => {
  it("is the closed v1 union", () => {
    expect(QUESTION_TYPE_IDS).toEqual(["noul", "choice", "score"]);
    expect(QuestionTypeId.options).toEqual(["noul", "choice", "score"]);
    expect(isQuestionTypeId("score")).toBe(true);
    expect(isQuestionTypeId("rank")).toBe(false);
    expect(isQuestionTypeId("toString")).toBe(false);
  });

  it("keys the module map by every type id", () => {
    expectTypeOf<keyof QuestionTypeModules>().toEqualTypeOf<QuestionTypeId>();
  });
});

describe("QuestionTypeModule", () => {
  it("can be implemented for a type", () => {
    const noul: NoulTypeModule = {
      id: "noul",
      questionSchema: NoulQuestion,
      answerSchema: NoulAnswer,
      compile: (q) => ({ type: "noul", instructions: q.instructions, criteria: q.criteria }),
      band: (answer, policy) =>
        answer.noul >= policy.noul.trueAt
          ? { value: true, band: "high" }
          : answer.noul <= policy.noul.falseAt
            ? { value: false, band: "high" }
            : { value: null, band: "low" },
      compositeValue: (answer) => answer.noul,
      lints: [],
      manifestHint: (q) => ({ type: "noul", label: q.meta.label }),
      uiKind: "boolean",
    };
    const q = NoulQuestion.parse({ type: "noul", instructions: "Is it?", meta });
    expect(noul.compile(q)).toEqual({ type: "noul", instructions: "Is it?", criteria: undefined });
    expect(noul.manifestHint(q)).toEqual({ type: "noul", label: "Label" });
    const policy = {
      type: "noul" as const,
      gating: true,
      noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
      actions: { high: { kind: "auto" as const }, medium: { kind: "review" as const }, low: { kind: "review" as const } },
    };
    expect(noul.band({ type: "noul", noul: 0.9 }, policy)).toEqual({ value: true, band: "high" });
  });
});

describe("QuestionTypeModules", () => {
  it("dispatches through the map for a generic type, with no switch and no cast", () => {
    // Compile-time check: these generic helpers must typecheck without `as` or `never`.
    function compileAny<K extends QuestionTypeId>(
      modules: QuestionTypeModules,
      q: QuestionOf<K> & { type: K },
    ): SystemOneQuestion {
      return modules[q.type].compile(q);
    }
    function bandAny<K extends QuestionTypeId>(
      modules: QuestionTypeModules,
      type: K,
      answer: AnswerOf<K>,
      policy: PolicyOf<K>,
    ): { value: unknown; band: string } {
      return modules[type].band(answer, policy);
    }
    expectTypeOf(compileAny).returns.toEqualTypeOf<SystemOneQuestion>();
    expectTypeOf(bandAny).toBeFunction();
    expectTypeOf<QuestionTypeModules["choice"]>().toEqualTypeOf<ChoiceTypeModule>();
  });
});
