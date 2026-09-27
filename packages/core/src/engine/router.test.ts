import { describe, expect, it } from "vitest";
import type { Action, Band, Channel, RolloutStage } from "../contracts/common.js";
import type { ActionRef, CompositePolicy, ConfidencePolicy } from "../contracts/policy.js";
import type { Composite, OnUnavailable, QuestionSetSpec } from "../contracts/spec.js";
import type { SystemOneAnswer } from "../contracts/system-one.js";
import { exampleSpec } from "../test/harness.js";
import { effectiveAction, isExecuted, isOutageExecuted, outageEffectiveAction, routingStage } from "./effective-action.js";
import { type RouterInput, compositeLevel, escalationConfigOf, fallbackConfigOf, routeAnswers, routeOutage, summarizeDecisions } from "./router.js";

const NOUL_FOR_BAND: Record<Band, number> = { high: 0.97, medium: 0.8, low: 0.5 };

function noulPolicy(gating: boolean, action: ActionRef, extra: Partial<ConfidencePolicy> = {}): ConfidencePolicy {
  return {
    type: "noul",
    gating,
    noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
    actions: { high: action, medium: action, low: action },
    ...extra,
  } as ConfidencePolicy;
}

function spec(policies: Record<string, ConfidencePolicy>, extra: Partial<QuestionSetSpec> = {}): QuestionSetSpec {
  const questions = Object.fromEntries(
    Object.keys(policies).map((id) => [id, { type: "noul" as const, instructions: `Is ${id} true for \`email\`?`, meta: { label: id } }]),
  );
  return {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: { schema: { type: "object" } },
    stages: [{ id: "main", questions }],
    policies,
    ...extra,
  };
}

function input(s: QuestionSetSpec, answers: Record<string, SystemOneAnswer>, over: Partial<RouterInput> = {}): RouterInput {
  return {
    spec: s,
    answers,
    asked: new Set(s.stages.flatMap((st) => Object.keys(st.questions))),
    checks: {},
    input: {},
    rollout: "full",
    channel: "production",
    dispatchActionsOnStaging: false,
    ...over,
  };
}

const noul = (band: Band): SystemOneAnswer => ({ type: "noul", noul: NOUL_FOR_BAND[band] });

// One row per row of the normative stage x band x action table, expanded
// over the policy actions that change the outcome.
type Row = { stage: RolloutStage; band: Band; gating: boolean; action: Action; eff: Action; executed: boolean };
const table: Row[] = [
  { stage: "inactive", band: "high", gating: true, action: "auto", eff: "fallback", executed: false },
  { stage: "shadow", band: "high", gating: true, action: "auto", eff: "fallback", executed: false },
  { stage: "shadow", band: "low", gating: true, action: "review", eff: "fallback", executed: false },
  { stage: "shadow", band: "medium", gating: false, action: "escalate_to_llm", eff: "fallback", executed: false },
  { stage: "controlled", band: "high", gating: true, action: "auto", eff: "auto", executed: true },
  { stage: "controlled", band: "high", gating: false, action: "review", eff: "review", executed: true },
  { stage: "controlled", band: "high", gating: true, action: "fallback", eff: "fallback", executed: true },
  { stage: "controlled", band: "high", gating: true, action: "escalate_to_llm", eff: "escalate_to_llm", executed: true },
  { stage: "controlled", band: "medium", gating: true, action: "auto", eff: "review", executed: true },
  { stage: "controlled", band: "low", gating: true, action: "fallback", eff: "review", executed: true },
  { stage: "controlled", band: "medium", gating: false, action: "auto", eff: "fallback", executed: false },
  { stage: "controlled", band: "low", gating: false, action: "fallback", eff: "fallback", executed: false },
  { stage: "full", band: "high", gating: true, action: "auto", eff: "auto", executed: true },
  { stage: "full", band: "medium", gating: false, action: "auto", eff: "auto", executed: true },
  { stage: "full", band: "low", gating: true, action: "review", eff: "review", executed: true },
  { stage: "full", band: "low", gating: false, action: "fallback", eff: "fallback", executed: true },
  { stage: "full", band: "medium", gating: true, action: "escalate_to_llm", eff: "escalate_to_llm", executed: true },
  { stage: "paused", band: "high", gating: true, action: "auto", eff: "fallback", executed: false },
  { stage: "paused", band: "low", gating: true, action: "review", eff: "fallback", executed: false },
];

describe("effective action: the normative table", () => {
  for (const channel of ["production", "staging"] as const) {
    it.each(table)(`${channel}: $stage, $band, gating $gating, $action -> $eff (executed $executed)`, (row) => {
      const s = spec({ q: noulPolicy(row.gating, { kind: row.action } as ActionRef) });
      const out = routeAnswers(input(s, { q: noul(row.band) }, { rollout: row.stage, channel }));
      const d = out.decisions["q"];
      expect(d).toMatchObject({ kind: "question", band: row.band, action: row.action, effectiveAction: row.eff, executed: row.executed, relevant: true });
    });
  }

  it("slug@draft runs behave as shadow whatever the pointer says", () => {
    expect(routingStage("full", "draft")).toBe("shadow");
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) });
    const out = routeAnswers(input(s, { q: noul("high") }, { rollout: "full", channel: "draft" }));
    expect(out.decisions["q"]).toMatchObject({ effectiveAction: "fallback", executed: false });
  });

  const handler = { kind: "auto", handler: "builtin.slack.notify" } as const;
  it.each([
    ["production", false, true],
    ["staging", false, false],
    ["staging", true, true],
  ] as Array<[Channel, boolean, boolean]>)("auto with a handler on %s (dispatchActionsOnStaging %s) executes: %s", (channel, dispatch, executed) => {
    const s = spec({ q: noulPolicy(true, handler) });
    const out = routeAnswers(input(s, { q: noul("high") }, { channel, dispatchActionsOnStaging: dispatch }));
    expect(out.decisions["q"]).toMatchObject({ effectiveAction: "auto", executed });
  });

  it("auto without a handler executes on staging", () => {
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) });
    expect(routeAnswers(input(s, { q: noul("high") }, { channel: "staging" })).decisions["q"]?.executed).toBe(true);
  });

  it("nothing executes on the challenger arm, but effective actions stay", () => {
    const s = spec({ a: noulPolicy(true, { kind: "auto" }), b: noulPolicy(true, { kind: "review" }) });
    const out = routeAnswers(input(s, { a: noul("high"), b: noul("low") }, { arm: "challenger" }));
    expect(out.decisions["a"]).toMatchObject({ effectiveAction: "auto", executed: false });
    expect(out.decisions["b"]).toMatchObject({ effectiveAction: "review", executed: false });
  });

  it("an irrelevant input is fallback in every stage", () => {
    for (const stage of ["shadow", "controlled", "full", "paused"] as const) {
      expect(effectiveAction({ stage, band: "high", action: "auto", gating: true, relevant: false })).toBe("fallback");
    }
    expect(
      isExecuted({ stage: "full", band: "high", relevant: false, action: "auto", effectiveAction: "fallback", handler: undefined, channel: "production", dispatchActionsOnStaging: false, arm: undefined }),
    ).toBe(false);
  });
});

describe("relevance (relevantWhen)", () => {
  const s = spec({
    gate: noulPolicy(false, { kind: "auto" }),
    spec_q: noulPolicy(true, { kind: "review" }, { relevantWhen: { q: "gate", eq: true } } as Partial<ConfidencePolicy>),
  });

  it("an irrelevant decision keeps its value, band and action, and is fallback, not executed", () => {
    const out = routeAnswers(input(s, { gate: noul("high"), spec_q: noul("low") }, { rollout: "full" }));
    // gate is high with value true, so spec_q is relevant here.
    expect(out.decisions["spec_q"]).toMatchObject({ relevant: true, effectiveAction: "review" });
    const off = routeAnswers(input(s, { gate: { type: "noul", noul: 0.02 }, spec_q: noul("low") }));
    expect(off.decisions["spec_q"]).toMatchObject({ value: null, band: "low", action: "review", relevant: false, effectiveAction: "fallback", executed: false });
  });

  it("does not lower runBand or overallAction", () => {
    const off = routeAnswers(input(s, { gate: { type: "noul", noul: 0.02 }, spec_q: noul("low") }));
    // The only relevant decision is non-gating and high.
    expect(off.runBand).toBe("high");
    expect(off.overallAction).toBe("auto");
  });
});

describe("skipped and empty decisions", () => {
  it("a question in a skipped spec stage", () => {
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) });
    const out = routeAnswers(input(s, {}, { asked: new Set() }));
    expect(out.decisions["q"]).toEqual({ kind: "question", value: null, band: "low", relevant: false, action: "fallback", effectiveAction: "fallback", executed: false });
    expect(out.views).toEqual({});
    expect(out.runBand).toBe("low");
    expect(out.overallAction).toBe("fallback");
  });

  it("a skipped question with no policy, and a composite with no term and no policy", () => {
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) }, { composites: [{ id: "c", kind: "weighted", terms: [{ q: "q", weight: 1 }] }] });
    const out = routeAnswers(input({ ...s, policies: {} }, {}, { asked: new Set() }));
    expect(out.decisions["q"]?.relevant).toBe(false);
    expect(out.decisions["c"]).toMatchObject({ kind: "composite", relevant: false, value: null });
    expect(out.meta["c"]).toMatchObject({ gating: false, counts: false });
  });

  it("a composite with no term left", () => {
    const composite: Composite = { id: "c", kind: "weighted", terms: [{ q: "q", weight: 1 }], policy: compositePolicy(true) };
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) }, { composites: [composite] });
    const out = routeAnswers(input(s, {}, { asked: new Set() }));
    expect(out.decisions["c"]).toEqual({ kind: "composite", value: null, band: "low", relevant: false, action: "fallback", effectiveAction: "fallback", executed: false });
    expect(out.composites["c"]).toBeNull();
  });
});

function compositePolicy(gating: boolean): CompositePolicy {
  return {
    type: "composite",
    gating,
    levelThresholds: { high: 0.7, medium: 0.4 },
    actions: { high: { kind: "auto", handler: "builtin.slack.notify" }, medium: { kind: "review" }, low: { kind: "fallback", config: { kind: "value", value: 0 } } },
  };
}

describe("composites", () => {
  const terms: Composite["terms"] = [
    { q: "a", weight: 0.5 },
    { q: "b", weight: 0.3 },
    { check: "is_reply", weight: 0.2 },
  ];
  const base = { a: noulPolicy(false, { kind: "auto" }), b: noulPolicy(false, { kind: "auto" }) };

  it("value is the weighted mean; band is the minimum question band; checks count as high", () => {
    const s = spec(base, { composites: [{ id: "c", kind: "weighted", terms, policy: compositePolicy(true) }] });
    const out = routeAnswers(input(s, { a: noul("high"), b: noul("medium") }, { checks: { is_reply: true } }));
    const expected = (0.5 * 0.97 + 0.3 * 0.8 + 0.2 * 1) / 1;
    expect(out.composites["c"]).toBeCloseTo(expected, 10);
    expect(out.decisions["c"]).toMatchObject({ kind: "composite", level: "high", band: "medium", action: "auto", effectiveAction: "auto", relevant: true });
  });

  it("the level picks the action and only the band feeds runBand", () => {
    // Confidently not urgent: low level, high band. It must not drag the run into review.
    const s = spec(base, { composites: [{ id: "c", kind: "weighted", terms: terms.slice(0, 2), policy: compositePolicy(true) }] });
    const out = routeAnswers(input(s, { a: { type: "noul", noul: 0.02 }, b: { type: "noul", noul: 0.03 } }));
    expect(out.decisions["c"]).toMatchObject({ level: "low", band: "high", action: "fallback" });
    expect(out.runBand).toBe("high");
  });

  it("a fallback value config replaces the value only when the fallback runs", () => {
    const s = spec(base, { composites: [{ id: "c", kind: "weighted", terms: terms.slice(0, 2), policy: compositePolicy(true) }] });
    const full = routeAnswers(input(s, { a: { type: "noul", noul: 0.02 }, b: { type: "noul", noul: 0.03 } }));
    expect(full.decisions["c"]?.value).toBe(0);
    expect(full.composites["c"]).toBeCloseTo(0.5 * 0.02 / 0.8 + 0.3 * 0.03 / 0.8, 10);
    const shadow = routeAnswers(input(s, { a: { type: "noul", noul: 0.02 }, b: { type: "noul", noul: 0.03 } }, { rollout: "shadow" }));
    expect(shadow.decisions["c"]?.value).toBeCloseTo(0.5 * 0.02 / 0.8 + 0.3 * 0.03 / 0.8, 10);
  });

  it("in controlled, a gating composite with a high level and a medium band goes to review", () => {
    const s = spec(base, { composites: [{ id: "c", kind: "weighted", terms: terms.slice(0, 2), policy: compositePolicy(true) }] });
    const out = routeAnswers(input(s, { a: noul("high"), b: noul("medium") }, { rollout: "controlled" }));
    expect(out.decisions["c"]).toMatchObject({ level: "high", band: "medium", action: "auto", effectiveAction: "review", executed: true });
  });

  it("irrelevant and unreadable terms are left out and the rest renormalize", () => {
    const withRelevance = {
      a: noulPolicy(false, { kind: "auto" }, { relevantWhen: { check: "is_reply" } } as Partial<ConfidencePolicy>),
      b: noulPolicy(false, { kind: "auto" }),
    };
    const s = spec(withRelevance, { composites: [{ id: "c", kind: "weighted", terms: terms.slice(0, 2), policy: compositePolicy(false) }] });
    const out = routeAnswers(input(s, { a: noul("high"), b: noul("medium") }, { checks: { is_reply: false } }));
    expect(out.composites["c"]).toBeCloseTo(0.8, 10);
    const unreadable = routeAnswers(input(s, { a: { type: "mystery" }, b: noul("medium") } as Record<string, SystemOneAnswer>, { checks: { is_reply: true } }));
    expect(unreadable.composites["c"]).toBeCloseTo(0.8, 10);
  });

  it("a composite of check terms only is band high", () => {
    const s = spec(base, { composites: [{ id: "c", kind: "weighted", terms: [{ check: "is_reply", weight: 1 }], policy: compositePolicy(false) }] });
    const out = routeAnswers(input(s, { a: noul("low"), b: noul("low") }, { checks: {} }));
    expect(out.decisions["c"]).toMatchObject({ value: 0, band: "high", level: "low" });
  });

  it("a composite with no policy never gates and is auto, or fallback when every action is forced", () => {
    const s = spec({ a: noulPolicy(true, { kind: "review" }) }, { composites: [{ id: "c", kind: "weighted", terms: [{ q: "a", weight: 1 }] }] });
    const full = routeAnswers(input(s, { a: noul("low") }));
    expect(full.decisions["c"]).toEqual({ kind: "composite", value: 0.5, band: "low", relevant: true, action: "auto", effectiveAction: "auto", executed: false });
    expect(full.overallAction).toBe("review");
    for (const rollout of ["shadow", "paused"] as const) {
      expect(routeAnswers(input(s, { a: noul("low") }, { rollout })).decisions["c"]?.effectiveAction).toBe("fallback");
    }
    expect(routeAnswers(input(s, { a: noul("low") }, { channel: "draft" })).decisions["c"]?.effectiveAction).toBe("fallback");
    expect(routeAnswers(input(s, { a: noul("low") }, { rollout: "controlled" })).decisions["c"]?.effectiveAction).toBe("auto");
  });

  it("a composite with no policy does not feed runBand even when nothing gates", () => {
    const s = spec({ a: noulPolicy(false, { kind: "auto" }) }, { composites: [{ id: "c", kind: "weighted", terms: [{ q: "a", weight: 1 }] }] });
    const out = routeAnswers(input(s, { a: noul("high") }));
    expect(out.runBand).toBe("high");
  });

  it("compositeLevel edges", () => {
    const t = { high: 0.7, medium: 0.4 };
    expect(compositeLevel(0.7, t)).toBe("high");
    expect(compositeLevel(0.6999, t)).toBe("medium");
    expect(compositeLevel(0.4, t)).toBe("medium");
    expect(compositeLevel(0.3999, t)).toBe("low");
  });
});

describe("conservative ordering: review > fallback > escalate_to_llm > auto", () => {
  const cases: Array<[Action[], Action]> = [
    [["auto", "escalate_to_llm"], "escalate_to_llm"],
    [["auto", "escalate_to_llm", "fallback"], "fallback"],
    [["auto", "fallback", "review"], "review"],
    [["auto", "auto"], "auto"],
  ];
  it.each(cases)("%j -> %s", (actions, expected) => {
    const policies = Object.fromEntries(actions.map((a, i) => [`q${i}`, noulPolicy(true, { kind: a } as ActionRef)]));
    const answers = Object.fromEntries(actions.map((_, i) => [`q${i}`, noul("high")]));
    expect(routeAnswers(input(spec(policies), answers)).overallAction).toBe(expected);
  });

  it("gating decisions decide; with none, every relevant decision; with none relevant, low and fallback", () => {
    const s = spec({ g: noulPolicy(true, { kind: "auto" }), n: noulPolicy(false, { kind: "review" }) });
    const out = routeAnswers(input(s, { g: noul("high"), n: noul("low") }));
    expect(out.runBand).toBe("high");
    expect(out.overallAction).toBe("auto");
    const noGating = spec({ a: noulPolicy(false, { kind: "auto" }), b: noulPolicy(false, { kind: "review" }) });
    const out2 = routeAnswers(input(noGating, { a: noul("high"), b: noul("medium") }));
    expect(out2.runBand).toBe("medium");
    expect(out2.overallAction).toBe("review");
    expect(summarizeDecisions({}, {})).toEqual({ runBand: "low", overallAction: "fallback" });
  });
});

describe("unreadable answers never throw", () => {
  const s = spec({ q: noulPolicy(true, { kind: "auto" }) });

  it("an unknown answer type is stored raw, band low, fallback, warning unknown_answer_type", () => {
    const raw = { type: "ranking", order: ["a", "b"] } as SystemOneAnswer;
    const out = routeAnswers(input(s, { q: raw }));
    expect(out.decisions["q"]).toMatchObject({ value: null, band: "low", relevant: true, effectiveAction: "fallback", executed: false, action: "auto" });
    expect(out.warnings).toEqual(["unknown_answer_type"]);
    expect(out.views["q"]?.type).toBe("ranking");
  });

  it("a known type that differs from the question, or a malformed answer, is answer_type_mismatch", () => {
    const wrong = { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } } as SystemOneAnswer;
    expect(routeAnswers(input(s, { q: wrong })).warnings).toEqual(["answer_type_mismatch"]);
    const malformed = { type: "noul", noul: "high" } as unknown as SystemOneAnswer;
    expect(routeAnswers(input(s, { q: malformed })).warnings).toEqual(["answer_type_mismatch"]);
  });

  it("a missing answer is answer_missing; a missing policy is policy_missing", () => {
    expect(routeAnswers(input(s, {})).warnings).toEqual(["answer_missing"]);
    const noPolicy = { ...s, policies: {} };
    const out = routeAnswers(input(noPolicy, { q: noul("high") }));
    expect(out.warnings).toEqual(["policy_missing"]);
    expect(out.decisions["q"]).toMatchObject({ action: "fallback", effectiveAction: "fallback", relevant: true });
    expect(out.runBand).toBe("low");
  });

  it("a composite policy on a question reads as policy_missing", () => {
    const odd = { ...s, policies: { q: compositePolicy(true) } };
    expect(routeAnswers(input(odd, { q: noul("high") })).warnings).toEqual(["policy_missing"]);
  });
});

describe("fallback values and routes", () => {
  it("a question fallback value config sets the value when the fallback runs", () => {
    const s = spec({ q: noulPolicy(true, { kind: "fallback", config: { kind: "value", value: "none" } }) });
    expect(routeAnswers(input(s, { q: noul("low") })).decisions["q"]?.value).toBe("none");
    expect(routeAnswers(input(s, { q: noul("low") }, { rollout: "shadow" })).decisions["q"]?.value).toBeNull();
    const noConfig = spec({ q: noulPolicy(true, { kind: "fallback" }) });
    expect(routeAnswers(input(noConfig, { q: noul("high") })).decisions["q"]?.value).toBe(true);
  });

  it("first matching route wins, then defaultRoute, then null", () => {
    const s = spec(
      { q: noulPolicy(true, { kind: "auto" }) },
      { routes: [{ when: { q: "q", eq: true }, output: "yes" }, { when: { q: "q", band: "high" }, output: "sure" }], defaultRoute: "normal" },
    );
    expect(routeAnswers(input(s, { q: noul("high") })).route).toBe("yes");
    expect(routeAnswers(input(s, { q: { type: "noul", noul: 0.02 } })).route).toBe("sure");
    expect(routeAnswers(input(s, { q: noul("low") })).route).toBe("normal");
    const { defaultRoute: _d, ...noDefault } = s;
    expect(routeAnswers(input(noDefault, { q: noul("low") })).route).toBeNull();
  });

  it("config helpers", () => {
    expect(escalationConfigOf(null)).toBeNull();
    expect(escalationConfigOf({ kind: "auto" })).toBeNull();
    expect(escalationConfigOf({ kind: "escalate_to_llm" })).toEqual({});
    expect(escalationConfigOf({ kind: "escalate_to_llm", config: { model: "m" } })).toEqual({ model: "m" });
    expect(fallbackConfigOf({ kind: "review" })).toBeNull();
    expect(fallbackConfigOf({ kind: "fallback" })).toEqual({ kind: "noop" });
  });
});

describe("the example spec", () => {
  it("routes the demo answers: urgent, work request, everything auto in full", () => {
    const s = exampleSpec();
    const out = routeAnswers({
      spec: s,
      answers: {
        real_person: { type: "noul", noul: 0.97 },
        someone_waiting: { type: "noul", noul: 0.9 },
        cost_of_ignoring: { type: "score", score: 2.2, confidence: 0.8, legend: { "0": "a", "1": "b", "2": "c", "3": "d" }, probabilities: { "0": 0, "1": 0.1, "2": 0.6, "3": 0.3 } },
        category: { type: "choice", choice: "work_request", confidence: 0.82, probabilities: { work_request: 0.9, none_of_these: 0.1 } },
        work_type: { type: "choice", choice: "decision", confidence: 0.79, probabilities: { decision: 0.9, none_of_these: 0.1 } },
      },
      asked: new Set(["real_person", "someone_waiting", "cost_of_ignoring", "category", "work_type"]),
      checks: {},
      input: {},
      rollout: "full",
      channel: "production",
      dispatchActionsOnStaging: false,
    });
    expect(out.route).toBe("urgent");
    expect(out.decisions["work_type"]?.relevant).toBe(true);
    expect(out.overallAction).toBe("auto");
    expect(out.runBand).toBe("high");
  });
});

// The outage rows of the effective-action table. One row per rollout stage, gating and
// outage rule. `eff` is every decision's effectiveAction when System One was unavailable.
type OutageRow = { stage: RolloutStage; gating: boolean; rule: OnUnavailable; eff: Action; executed: boolean };
const OUTAGE_STAGES: RolloutStage[] = ["inactive", "shadow", "controlled", "full", "paused"];
const outageTable: OutageRow[] = OUTAGE_STAGES.flatMap((stage) =>
  (["fallback", "review", "escalate_to_llm"] as const).flatMap((rule) =>
    [true, false].map((gating): OutageRow => {
      const acts = gating && (stage === "controlled" || stage === "full");
      const eff: Action = acts ? rule : "fallback";
      return { stage, gating, rule, eff, executed: eff !== "fallback" };
    }),
  ),
);

describe("outage: the effective-action table across rollout stages", () => {
  it("has a row for every stage, gating value and outage rule, and none resolves to auto", () => {
    expect(outageTable).toHaveLength(5 * 3 * 2);
    expect(outageTable.every((r) => r.eff !== "auto")).toBe(true);
  });

  it.each(outageTable)("$stage, gating $gating, onUnavailable $rule -> $eff (executed $executed)", (row) => {
    expect(outageEffectiveAction({ stage: row.stage, kind: "question", gating: row.gating, relevant: true, onUnavailable: row.rule })).toBe(row.eff);
    const s = spec({ q: noulPolicy(row.gating, { kind: "auto" }) }, { onUnavailable: row.rule });
    const out = routeOutage({ spec: s, skipped: new Set(), rollout: row.stage, channel: "production" });
    expect(out.decisions["q"]).toEqual({ kind: "question", value: null, band: "low", relevant: true, action: row.eff, effectiveAction: row.eff, executed: row.executed });
    expect(out.runBand).toBe("low");
    expect(out.route).toBeNull();
  });

  it("an irrelevant decision is fallback whatever the rule", () => {
    for (const stage of OUTAGE_STAGES) {
      expect(outageEffectiveAction({ stage, kind: "question", gating: true, relevant: false, onUnavailable: "review" })).toBe("fallback");
    }
  });

  it("a composite cannot escalate: escalate_to_llm becomes review for it", () => {
    expect(outageEffectiveAction({ stage: "full", kind: "composite", gating: true, relevant: true, onUnavailable: "escalate_to_llm" })).toBe("review");
    expect(outageEffectiveAction({ stage: "full", kind: "composite", gating: true, relevant: true, onUnavailable: "fallback" })).toBe("fallback");
  });

  it("an omitted rule is review, and slug@draft behaves as shadow", () => {
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) });
    expect(routeOutage({ spec: s, skipped: new Set(), rollout: "full", channel: "production" }).decisions["q"]).toMatchObject({ effectiveAction: "review", executed: true });
    const review = { ...s, onUnavailable: "review" as const };
    expect(routeOutage({ spec: review, skipped: new Set(), rollout: "full", channel: "draft" }).decisions["q"]?.effectiveAction).toBe("fallback");
  });

  it("the challenger arm executes nothing but keeps the effective action", () => {
    const s = spec({ q: noulPolicy(true, { kind: "auto" }) }, { onUnavailable: "review" });
    const out = routeOutage({ spec: s, skipped: new Set(), rollout: "full", channel: "production", arm: "challenger" });
    expect(out.decisions["q"]).toMatchObject({ effectiveAction: "review", executed: false });
    expect(isOutageExecuted({ effectiveAction: "escalate_to_llm", arm: "champion" })).toBe(true);
    expect(isOutageExecuted({ effectiveAction: "fallback", arm: undefined })).toBe(false);
  });

  it("keeps skipped-stage questions skipped, gives composites the rule, and summarizes conservatively", () => {
    const composite = (id: string, policy?: CompositePolicy): Composite => ({ id, kind: "weighted", terms: [{ q: "a", weight: 1 }], ...(policy ? { policy } : {}) });
    const cpol = (gating: boolean): CompositePolicy => ({ type: "composite", gating, levelThresholds: { high: 0.7, medium: 0.4 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "fallback" } } });
    const s = spec(
      { a: noulPolicy(true, { kind: "auto" }), b: noulPolicy(false, { kind: "auto" }), c: noulPolicy(true, { kind: "auto" }) },
      { onUnavailable: "escalate_to_llm", composites: [composite("urgency", cpol(true)), composite("soft", cpol(false)), composite("bare")] },
    );
    const out = routeOutage({ spec: s, skipped: new Set(["c"]), rollout: "full", channel: "production" });
    expect(out.decisions["a"]).toMatchObject({ effectiveAction: "escalate_to_llm", executed: true });
    expect(out.meta["a"]?.actionRef).toEqual({ kind: "escalate_to_llm" });
    expect(out.decisions["b"]).toMatchObject({ effectiveAction: "fallback", executed: false });
    expect(out.meta["b"]?.actionRef).toBeNull();
    expect(out.decisions["c"]).toMatchObject({ relevant: false, effectiveAction: "fallback", executed: false });
    expect(out.decisions["urgency"]).toMatchObject({ kind: "composite", value: null, band: "low", effectiveAction: "review", executed: true });
    expect(out.decisions["soft"]?.effectiveAction).toBe("fallback");
    expect(out.decisions["bare"]?.effectiveAction).toBe("fallback");
    expect(out.meta["bare"]?.counts).toBe(false);
    expect(out.overallAction).toBe("review");
    expect(out.runBand).toBe("low");
    expect(Object.values(out.decisions).some((d) => d.effectiveAction === "auto")).toBe(false);
  });

  it("an outage escalation reuses the question's own escalate_to_llm config, low band first", () => {
    const escalate = { kind: "escalate_to_llm", config: { model: "claude-haiku-4-5", maxOutputTokens: 8 } } as const;
    const policy = { ...noulPolicy(true, { kind: "auto" }), actions: { high: { kind: "auto" }, medium: escalate, low: { kind: "review" } } } as ConfidencePolicy;
    const s = spec({ q: policy }, { onUnavailable: "escalate_to_llm" });
    expect(routeOutage({ spec: s, skipped: new Set(), rollout: "controlled", channel: "production" }).meta["q"]?.actionRef).toEqual(escalate);
    const noPolicy = { ...s, policies: {} };
    expect(routeOutage({ spec: noPolicy, skipped: new Set(), rollout: "full", channel: "production" }).decisions["q"]?.effectiveAction).toBe("fallback");
  });
});
