import { describe, expect, it } from "vitest";

import { Action } from "./common.js";
import { Manifest } from "./manifest.js";

const manifest = {
  setId: "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f60",
  slug: "email-triage",
  version: 7,
  versionId: "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f61",
  channel: "production",
  model: "jev-1.13.0",
  interfaceMajor: 2,
  interfaceHash: "sha256:4f1c9e",
  inputSchema: {
    type: "object",
    properties: { email: { type: "object" } },
    required: ["email"],
  },
  questions: [
    { id: "real_person", type: "noul", label: "Real person?" },
    {
      id: "category",
      type: "choice",
      label: "Category",
      description: "What kind of email this is",
      options: ["work_request", "scheduling", "none_of_these"],
    },
    { id: "urgency", type: "score", label: "Urgency", levels: 5 },
  ],
  composites: ["priority"],
  routeOutputs: ["urgent", "read_later", "normal"],
  actions: [...Action.options],
};

describe("Manifest", () => {
  it("parses a manifest and round-trips", () => {
    const parsed = Manifest.parse(manifest);
    expect(parsed).toEqual(manifest);
    expect(Manifest.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("drops instructions, criteria and thresholds if a producer leaks them", () => {
    const leaky = {
      ...manifest,
      instructions: "secret prompt",
      policies: { urgency: { thresholds: { high: 0.9 } } },
      questions: [{ ...manifest.questions[0], instructions: "x", criteria: { true: "y" } }],
    };
    const parsed = Manifest.parse(leaky);
    expect(parsed).not.toHaveProperty("instructions");
    expect(parsed).not.toHaveProperty("policies");
    expect(parsed.questions[0]).not.toHaveProperty("instructions");
    expect(parsed.questions[0]).not.toHaveProperty("criteria");
  });

  it("rejects bad question ids, unknown types and bad level counts", () => {
    const bad = (q: object) => Manifest.safeParse({ ...manifest, questions: [q] }).success;
    expect(bad({ id: "Bad-Id", type: "noul", label: "x" })).toBe(false);
    expect(bad({ id: "q", type: "ranking", label: "x" })).toBe(false);
    expect(bad({ id: "q", type: "score", label: "x", levels: 0 })).toBe(false);
  });

  it("rejects an unknown action and a missing interface hash", () => {
    expect(Manifest.safeParse({ ...manifest, actions: ["auto", "ship_it"] }).success).toBe(false);
    const { interfaceHash: _omit, ...rest } = manifest;
    expect(Manifest.safeParse(rest).success).toBe(false);
  });

  it("accepts a draft ref", () => {
    expect(Manifest.safeParse({ ...manifest, channel: "draft", model: "jev-latest" }).success).toBe(true);
  });
});
