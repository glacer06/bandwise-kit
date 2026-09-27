import { describe, expect, it } from "vitest";
import {
  ActionRef,
  BandActions,
  Check,
  CompositePolicy,
  Condition,
  ConfidencePolicy,
  EscalationConfig,
  FallbackConfig,
  matchesPatternProblem,
} from "./policy.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const actions = { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } };

describe("Condition", () => {
  it("accepts every leaf and combinator", () => {
    const conditions: unknown[] = [
      { q: "category", eq: "work_request" },
      { q: "is_spam", neq: null },
      { q: "category", in: ["a", "b", 1, true, null] },
      { q: "category", band: "high" },
      { q: "urgency", gte: 1 },
      { q: "urgency", lte: 2 },
      { q: "urgency", gte: 1, lte: 2 },
      { composite: "urgency", gte: 0.7 },
      { check: "has_body" },
      { input: "email.from", eq: "a@b.c" },
      { input: "email.from", neq: "a@b.c" },
      { input: "items[0].sku", in: ["x"] },
      { input: "email.body", exists: false },
      { input: "email.from", matches: "@noreply\\." },
      { input: "order.total", lte: 100 },
      {
        all: [
          { q: "category", eq: "work_request" },
          { q: "category", band: "high" },
          { not: { input: "email.from", matches: "@noreply\\." } },
        ],
      },
      { any: [] },
    ];
    for (const c of conditions) expect(ok(Condition, c), JSON.stringify(c)).toBe(true);
  });

  it("requires at least one bound on a range leaf", () => {
    expect(ok(Condition, { q: "urgency" })).toBe(false);
    expect(ok(Condition, { composite: "urgency" })).toBe(false);
    expect(ok(Condition, { input: "order.total" })).toBe(false);
  });

  it("rejects mixed leaves, unknown keys and unknown operators", () => {
    expect(ok(Condition, { q: "category", eq: "a", band: "high" })).toBe(false);
    expect(ok(Condition, { q: "category", eq: "a", note: "x" })).toBe(false);
    expect(ok(Condition, { q: "category", gt: 1 })).toBe(false);
    expect(ok(Condition, { input: "a", exists: "yes" })).toBe(false);
    expect(ok(Condition, { q: "category", band: "certain" })).toBe(false);
    expect(ok(Condition, { not: [{ check: "x" }] })).toBe(false);
    expect(ok(Condition, { q: "Category", eq: "a" })).toBe(false);
    expect(ok(Condition, { input: "", exists: true })).toBe(false);
  });

  it("caps matches at 256 characters", () => {
    expect(ok(Condition, { input: "a", matches: "x".repeat(256) })).toBe(true);
    expect(ok(Condition, { input: "a", matches: "x".repeat(257) })).toBe(false);
  });

  it("accepts only the linear-time subset in matches", () => {
    for (const good of ["^(Re|RE):", "@noreply\\.", "[(?=]x", "\\(?=", "a{2,5}b*", "(?:ab)+", "(?<name>x)"]) {
      expect(ok(Condition, { input: "a", matches: good }), good).toBe(true);
      expect(matchesPatternProblem(good), good).toBeNull();
    }
    for (const bad of ["(a)\\1", "(?<n>a)\\k<n>", "a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "(", "[a-"]) {
      expect(ok(Condition, { input: "a", matches: bad }), bad).toBe(false);
      expect(matchesPatternProblem(bad), bad).not.toBeNull();
    }
  });

  it("parses deep nesting", () => {
    let c: unknown = { check: "has_body" };
    for (let i = 0; i < 20; i++) c = i % 2 ? { not: c } : { all: [c] };
    expect(ok(Condition, c)).toBe(true);
  });
});

describe("Check", () => {
  it("parses the documented examples and stays strict", () => {
    expect(ok(Check, { id: "has_body", when: { input: "email.body", exists: true } })).toBe(true);
    expect(ok(Check, { id: "is_reply", when: { input: "email.subject", matches: "^(Re|RE):" } })).toBe(true);
    expect(ok(Check, { id: "has_body", when: { input: "email.body", exists: true }, code: "x" })).toBe(false);
  });
});

describe("FallbackConfig and EscalationConfig", () => {
  it("accepts the three fallback kinds", () => {
    expect(ok(FallbackConfig, { kind: "value", value: "none_of_these" })).toBe(true);
    expect(ok(FallbackConfig, { kind: "value", value: null })).toBe(true);
    expect(ok(FallbackConfig, { kind: "set", setRef: "email-triage-lite" })).toBe(true);
    expect(ok(FallbackConfig, { kind: "noop" })).toBe(true);
    expect(ok(FallbackConfig, { kind: "value" })).toBe(false);
    expect(ok(FallbackConfig, { kind: "handler" })).toBe(false);
  });

  it("accepts an escalation config and rejects bad token counts", () => {
    expect(ok(EscalationConfig, { model: "claude-haiku-4-5", maxOutputTokens: 64 })).toBe(true);
    expect(ok(EscalationConfig, { instructions: { focus: "tone" } })).toBe(true);
    expect(ok(EscalationConfig, {})).toBe(true);
    expect(ok(EscalationConfig, { maxOutputTokens: 0 })).toBe(false);
    expect(ok(EscalationConfig, { maxOutputTokens: 1.5 })).toBe(false);
  });
});

describe("ActionRef", () => {
  it("types config by kind", () => {
    expect(ok(ActionRef, { kind: "fallback", config: { kind: "value", value: "none_of_these" } })).toBe(true);
    expect(ok(ActionRef, { kind: "fallback", config: { channel: "#ops" } })).toBe(false);
    expect(ok(ActionRef, { kind: "escalate_to_llm", config: { model: "claude-haiku-4-5", maxOutputTokens: 64 } })).toBe(
      true,
    );
    expect(ok(ActionRef, { kind: "escalate_to_llm", config: { temperature: 0 } })).toBe(false);
  });

  it("takes no config on a review action", () => {
    expect(ok(ActionRef, { kind: "review" })).toBe(true);
    expect(ok(ActionRef, { kind: "review", config: { queue: "ops" } })).toBe(false);
  });

  it("leaves handler config on auto free-form", () => {
    expect(
      ok(ActionRef, { kind: "auto", handler: "builtin.slack.notify", config: { channel: "#ops", any: [1] } }),
    ).toBe(true);
    expect(ok(ActionRef, { kind: "auto", handler: "example.post-webhook" })).toBe(true);
  });

  it("requires <namespace>.<name> handler ids and known kinds", () => {
    expect(ok(ActionRef, { kind: "auto", handler: "notify" })).toBe(false);
    expect(ok(ActionRef, { kind: "auto", handler: "Builtin.Slack" })).toBe(false);
    expect(ok(ActionRef, { kind: "ignore" })).toBe(false);
    expect(ok(ActionRef, { kind: "auto", extra: true })).toBe(false);
  });

  it("needs all three bands", () => {
    expect(ok(BandActions, actions)).toBe(true);
    expect(ok(BandActions, { high: { kind: "auto" }, low: { kind: "review" } })).toBe(false);
  });
});

describe("ConfidencePolicy", () => {
  it("parses each variant", () => {
    const policies: unknown[] = [
      { type: "noul", gating: true, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions },
      {
        type: "choice",
        gating: true,
        relevantWhen: { q: "category", eq: "work_request" },
        thresholds: { high: 0.75, medium: 0.45 },
        perOption: { approve_transfer: { high: 0.9, medium: 0.7 } },
        actions,
      },
      { type: "score", gating: false, thresholds: { high: 0.6, medium: 0.3 }, actions },
      { type: "composite", gating: true, levelThresholds: { high: 0.7, medium: 0.4 }, actions },
    ];
    for (const p of policies) expect(ok(ConfidencePolicy, p), JSON.stringify(p)).toBe(true);
  });

  it("parses the top-choice preset", () => {
    const preset = {
      type: "choice",
      gating: false,
      thresholds: { high: 0, medium: 0 },
      actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } },
    };
    expect(ok(ConfidencePolicy, preset)).toBe(true);
  });

  it("keeps each variant strict", () => {
    const noul = { type: "noul", gating: true, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions };
    expect(ok(ConfidencePolicy, { ...noul, thresholds: { high: 0.7, medium: 0.4 } })).toBe(false);
    expect(ok(ConfidencePolicy, { ...noul, rollout: "full" })).toBe(false);
    expect(ok(ConfidencePolicy, { type: "score", gating: true, thresholds: { high: 0.7, medium: 0.4 }, perOption: {}, actions })).toBe(
      false,
    );
    expect(
      ok(CompositePolicy, {
        type: "composite",
        gating: true,
        levelThresholds: { high: 0.7, medium: 0.4 },
        relevantWhen: { check: "x" },
        actions,
      }),
    ).toBe(false);
  });

  it("keeps thresholds within 0 to 1 and requires gating", () => {
    expect(ok(ConfidencePolicy, { type: "score", gating: true, thresholds: { high: 1.2, medium: 0.4 }, actions })).toBe(
      false,
    );
    expect(ok(ConfidencePolicy, { type: "score", thresholds: { high: 0.7, medium: 0.4 }, actions })).toBe(false);
    expect(ok(ConfidencePolicy, { type: "rank", gating: true, actions })).toBe(false);
  });

  it("rejects escalate_to_llm only in composite policies", () => {
    const escalate = { ...actions, low: { kind: "escalate_to_llm" } };
    expect(ok(ConfidencePolicy, { type: "score", gating: true, thresholds: { high: 0.7, medium: 0.4 }, actions: escalate })).toBe(
      true,
    );
    expect(
      ok(ConfidencePolicy, { type: "composite", gating: true, levelThresholds: { high: 0.7, medium: 0.4 }, actions: escalate }),
    ).toBe(false);
  });
});
