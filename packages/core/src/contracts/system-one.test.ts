import { describe, expect, it } from "vitest";
import {
  SYSTEM_ONE_LIMITS,
  SystemOneAnswer,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
  isKnownAnswer,
} from "./system-one.js";

describe("SystemOneRequest", () => {
  const request = {
    state: { ticket: "My card was charged twice" },
    model: "jev-latest",
    questions: {
      department: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: { billing: "Payments, refunds", technical: "Bugs, outages", other: null },
      },
      frustration: { type: "score", instructions: "How frustrated is the customer?", criteria: ["Calm", "Frustrated", "Very angry"] },
      is_urgent: {
        type: "noul",
        instructions: { question: "Does this convey urgency?", ticket: "`ticket`" },
        criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
      },
    },
  };

  it("parses the API request body", () => {
    expect(SystemOneRequest.parse(request)).toEqual(request);
  });

  it("accepts string and array state", () => {
    expect(SystemOneRequest.safeParse({ ...request, state: "plain text" }).success).toBe(true);
    expect(SystemOneRequest.safeParse({ ...request, state: [1, 2] }).success).toBe(true);
  });

  it("needs at least one question and a known type", () => {
    expect(SystemOneRequest.safeParse({ ...request, questions: {} }).success).toBe(false);
    expect(SystemOneQuestion.safeParse({ type: "rank", instructions: "x" }).success).toBe(false);
    expect(SystemOneQuestion.safeParse({ type: "noul", instructions: "x", label: "y" }).success).toBe(false);
  });

  it("carries the API-wide limits", () => {
    expect(SYSTEM_ONE_LIMITS).toEqual({ maxChoiceOptions: 255, minScoreLevels: 2, maxScoreLevels: 10 });
  });
});

describe("SystemOneAnswer", () => {
  it("parses each known answer type", () => {
    expect(SystemOneAnswer.parse({ type: "noul", noul: 0.91 })).toEqual({ type: "noul", noul: 0.91 });
    const choice = { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12 }, confidence: 0.81 };
    expect(SystemOneAnswer.parse(choice)).toEqual(choice);
    const score = {
      type: "score",
      score: 1.05,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.1, "1": 0.75, "2": 0.15 },
      confidence: 0.6,
    };
    expect(SystemOneAnswer.parse(score)).toEqual(score);
  });

  it("keeps fields a newer API adds (passthrough)", () => {
    const answer = { type: "noul", noul: 0.5, rationale_tokens: 12 };
    expect(SystemOneAnswer.parse(answer)).toEqual(answer);
  });

  it("stores an unknown answer type raw instead of failing", () => {
    const answer = { type: "rank", order: ["a", "b"], confidence: 0.4 };
    const parsed = SystemOneAnswer.parse(answer);
    expect(parsed).toEqual(answer);
    expect(isKnownAnswer(parsed)).toBe(false);
  });

  it("still rejects a known type that fails its own variant", () => {
    expect(SystemOneAnswer.safeParse({ type: "choice", choice: "billing" }).success).toBe(false);
    expect(SystemOneAnswer.safeParse({ type: "noul", noul: "high" }).success).toBe(false);
    expect(SystemOneAnswer.safeParse({ noul: 0.5 }).success).toBe(false);
  });

  it("narrows known answers", () => {
    const parsed = SystemOneAnswer.parse({ type: "noul", noul: 0.2 });
    expect(isKnownAnswer(parsed)).toBe(true);
  });
});

describe("SystemOneResponse", () => {
  const response = {
    model: "jev-1.13.0",
    answers: {
      department: { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12 }, confidence: 0.81 },
    },
    usage: { input_tokens: 318, output_tokens: 34 },
  };

  it("parses the documented response and keeps extra fields", () => {
    expect(SystemOneResponse.parse(response)).toEqual(response);
    const extended = { ...response, id: "resp_1", usage: { ...response.usage, cached_tokens: 0 } };
    expect(SystemOneResponse.parse(extended)).toEqual(extended);
  });

  it("rejects missing usage and negative token counts", () => {
    expect(SystemOneResponse.safeParse({ model: "jev-1.13.0", answers: {} }).success).toBe(false);
    expect(
      SystemOneResponse.safeParse({ ...response, usage: { input_tokens: -1, output_tokens: 0 } }).success,
    ).toBe(false);
  });
});
