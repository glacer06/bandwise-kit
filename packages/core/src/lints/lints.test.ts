import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../contracts/models.js";
import type { QuestionSetSpec } from "../contracts/spec.js";
import { LintResult } from "../contracts/spec.js";
import type { PublishCtx } from "../contracts/tenant.js";
import { SEED_MODEL_PROFILES, SEED_MODEL_ROUTES } from "../models/catalog.js";
import { interfaceOf } from "../interface.js";
import { exampleSpec } from "../test/harness.js";
import { LINT_RULES, hasLintErrors, lint } from "./index.js";

const jev = SEED_MODEL_PROFILES.find((p) => p.id === "jev-1.13.0") as ModelProfile;
const latest = SEED_MODEL_PROFILES.find((p) => p.id === "jev-latest") as ModelProfile;
const preview = SEED_MODEL_PROFILES.find((p) => p.id === "jev-preview") as ModelProfile;

function publishCtx(over: Partial<PublishCtx> = {}): PublishCtx {
  return {
    channel: "production",
    rolloutStage: "shadow",
    served: [],
    newMajor: 1,
    systemOneProvider: "typesafe",
    reachableModels: ["jev-1.13.0", "jev-latest", "jev-preview"],
    modelRoutes: [],
    pricedModels: ["jev-1.13.0", "claude-haiku-4-5"],
    allowPreviewModels: false,
    enabledHandlers: [],
    fallbackSets: {},
    hashOnly: false,
    ...over,
  };
}

const rules = (results: LintResult[]): string[] => results.map((r) => r.rule);
const errors = (results: LintResult[]): LintResult[] => results.filter((r) => r.severity === "error");

/** A clean minimal spec: one choice with a none option, a well-worded instruction, a sane policy. */
function minimal(): QuestionSetSpec {
  return {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: { schema: { type: "object", properties: { ticket: { type: "string", maxLength: 500 } } } },
    stages: [
      {
        id: "main",
        questions: {
          team: {
            type: "choice",
            instructions: "Which team should handle the support request in `ticket`?",
            criteria: { billing: "Payments and refunds", technical: "Bugs and outages", none_of_these: null },
            meta: { label: "Team" },
          },
        },
      },
    ],
    policies: {
      team: { type: "choice", gating: false, thresholds: { high: 0.75, medium: 0.45 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } },
    },
  };
}

describe("lint on clean specs", () => {
  it("the example spec lints with zero errors against the jev-1.13.0 seed profile", () => {
    const results = lint(exampleSpec(), jev);
    for (const r of results) LintResult.parse(r);
    expect(errors(results)).toEqual([]);
    expect(hasLintErrors(results)).toBe(false);
  });

  it("the example spec also passes publish lints on a shadow channel", () => {
    expect(errors(lint(exampleSpec(), jev, publishCtx()))).toEqual([]);
  });

  it("the minimal spec has no findings at all", () => {
    expect(lint(minimal(), jev)).toEqual([]);
    expect(lint(minimal(), jev, publishCtx({ rolloutStage: "full" }))).toEqual([]);
  });

  it("every emitted rule id is listed", () => {
    expect(new Set(LINT_RULES).size).toBe(LINT_RULES.length);
  });
});

type Case = { rule: string; build: () => { spec: QuestionSetSpec; profile?: ModelProfile | null; ctx?: PublishCtx } };

const cases: Case[] = [
  {
    rule: "state_path.unknown",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["team"]!.instructions = "Which team should handle the request in `ticket.body`?";
      return { spec: s };
    },
  },
  {
    rule: "policy.thresholds_order",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), thresholds: { high: 0.4, medium: 0.6 } } as never;
      return { spec: s };
    },
  },
  {
    rule: "policy.noul_order",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["urgent"] = { type: "noul", instructions: "Does the request in `ticket` say it is urgent?", meta: { label: "U" } };
      s.policies["urgent"] = { type: "noul", gating: false, noul: { trueAt: 0.6, falseAt: 0.4, reviewMargin: 0.2 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
      return { spec: s };
    },
  },
  {
    rule: "policy.per_option_keys",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), perOption: { sales: { high: 0.9, medium: 0.7 } } } as never;
      return { spec: s };
    },
  },
  {
    rule: "policy.type_mismatch",
    build: () => {
      const s = minimal();
      s.policies = {};
      return { spec: s };
    },
  },
  {
    rule: "policy.all_gating_thresholded",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), gating: true } as never;
      return { spec: s };
    },
  },
  {
    rule: "stage.same_stage_dependency",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["detail"] = {
        type: "noul",
        instructions: "Given the team `answers.team.value`, does `ticket` ask for a refund?",
        meta: { label: "D" },
      };
      s.policies["detail"] = { type: "noul", gating: false, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
      return { spec: s };
    },
  },
  {
    rule: "stage.needless_second_call",
    build: () => {
      const s = minimal();
      s.stages.push({
        id: "second",
        when: { q: "team", eq: "billing" },
        questions: { refund: { type: "noul", instructions: "Does the request in `ticket` ask for a refund of money?", meta: { label: "R" } } },
      });
      s.policies["refund"] = { type: "noul", gating: false, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
      return { spec: s };
    },
  },
  {
    rule: "relevance.premise_missing",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), relevantWhen: { input: "ticket", exists: true } } as never;
      return { spec: s };
    },
  },
  {
    rule: "tokens.near_limit",
    build: () => ({ spec: { ...minimal(), input: { ...minimal().input, maxStateTokens: 30_000 } } }),
  },
  {
    rule: "instructions.too_short",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["team"]!.instructions = "Which team for `ticket`?";
      return { spec: s };
    },
  },
  {
    rule: "redact.path_unknown",
    build: () => ({ spec: { ...minimal(), input: { ...minimal().input, redactPaths: ["ticket.author"] } } }),
  },
  {
    rule: "choice.missing_none",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["team"] = { ...s.stages[0]!.questions["team"]!, criteria: { billing: null, technical: null } } as never;
      return { spec: s };
    },
  },
  { rule: "model.unknown", build: () => ({ spec: minimal(), profile: null }) },
  { rule: "model.unreviewed", build: () => ({ spec: minimal(), profile: { ...jev, status: "unreviewed" } }) },
  { rule: "model.deprecated", build: () => ({ spec: minimal(), profile: { ...jev, status: "deprecated", retireAt: "2027-01-01" } }) },
  { rule: "model.question_type_unsupported", build: () => ({ spec: minimal(), profile: { ...jev, questionTypes: ["noul"] } }) },
  { rule: "model.not_available_to_org", build: () => ({ spec: minimal(), ctx: publishCtx({ reachableModels: ["jev-latest"] }) }) },
  {
    rule: "model.alias_past_shadow",
    build: () => ({ spec: { ...minimal(), model: "jev-latest" }, profile: latest, ctx: publishCtx({ rolloutStage: "controlled" }) }),
  },
  {
    rule: "action.handler_unknown",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), actions: { high: { kind: "auto", handler: "builtin.slack.notify" }, medium: { kind: "review" }, low: { kind: "review" } } } as never;
      return { spec: s, ctx: publishCtx() };
    },
  },
  {
    rule: "fallback.set_invalid",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "fallback", config: { kind: "set", setRef: "nope" } } } } as never;
      return { spec: s, ctx: publishCtx() };
    },
  },
  {
    rule: "escalation.model_unpriced",
    build: () => {
      const s = minimal();
      s.policies["team"] = { ...(s.policies["team"] as object), actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "escalate_to_llm", config: { model: "gpt-x" } } } } as never;
      return { spec: s, ctx: publishCtx() };
    },
  },
  {
    rule: "interface.breaking",
    build: () => {
      const before = interfaceOf(minimal());
      const s = minimal();
      s.stages[0]!.questions["team"] = { ...s.stages[0]!.questions["team"]!, criteria: { billing: null, none_of_these: null } } as never;
      return { spec: s, ctx: publishCtx({ served: [{ channel: "production", interface: before, interfaceMajor: 1, hasConsumers: true }], newMajor: 1 }) };
    },
  },
  {
    rule: "privacy.hash_only_with_review",
    build: () => ({ spec: minimal(), ctx: publishCtx({ hashOnly: true }) }),
  },
  {
    rule: "weakness.counting",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["team"]!.instructions = "How many people are copied on `ticket`, and which team handles it?";
      return { spec: s };
    },
  },
  {
    rule: "weakness.date_comparison",
    build: () => {
      const s = minimal();
      s.input.schema = { type: "object", properties: { ticket: { type: "string", maxLength: 10 }, due_date: { type: "string", maxLength: 10 } } };
      s.stages[0]!.questions["team"]!.instructions = "Is `due_date` before the end of this quarter, and which team handles `ticket`?";
      return { spec: s };
    },
  },
  {
    rule: "weakness.inverted_noul",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["calm"] = {
        type: "noul",
        instructions: "Does the customer who wrote `ticket` sound calm and patient?",
        criteria: { true: "The customer is not angry.", false: "The customer is angry." },
        meta: { label: "Calm" },
      };
      s.policies["calm"] = { type: "noul", gating: false, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
      return { spec: s };
    },
  },
  {
    rule: "weakness.generation",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["title"] = { type: "noul", instructions: "Extract the product name from `ticket` if one is mentioned there.", meta: { label: "T" } };
      s.policies["title"] = { type: "noul", gating: false, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
      return { spec: s };
    },
  },
  {
    rule: "weakness.large_unreferenced_state",
    build: () => {
      const s = minimal();
      s.input.schema = { type: "object", properties: { ticket: { type: "string" }, history: { type: "array" } } };
      return { spec: s };
    },
  },
  {
    rule: "weakness.threshold_copied",
    build: () => {
      const s = minimal();
      s.stages[0]!.questions["urgent"] = { type: "noul", instructions: "Does the request in `ticket` say it is urgent?", meta: { label: "U" } };
      s.policies["urgent"] = { type: "noul", gating: false, noul: { trueAt: 0.75, falseAt: 0.15, reviewMargin: 0.3 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
      return { spec: s };
    },
  },
  {
    rule: "outage.auto_not_allowed",
    build: () => {
      const s = minimal();
      (s as { onUnavailable?: unknown }).onUnavailable = "auto";
      return { spec: s };
    },
  },
  {
    rule: "outage.fallback_silent",
    build: () => ({ spec: { ...gatingSpec({ kind: "fallback", config: { kind: "noop" } }), onUnavailable: "fallback" } }),
  },
];

/** minimal() with team gating and its low band set to the given action. */
function gatingSpec(low: NonNullable<QuestionSetSpec["policies"][string]>["actions"]["low"]): QuestionSetSpec {
  const s = minimal();
  s.policies["team"] = { type: "choice", gating: true, thresholds: { high: 0.75, medium: 0.45 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low } };
  return s;
}

describe("outage.fallback_silent", () => {
  const silent = (s: QuestionSetSpec) => lint(s, jev).filter((r) => r.rule === "outage.fallback_silent");

  it("stays quiet on the default rule, even when a gating decision has no fallback value", () => {
    expect(silent(gatingSpec({ kind: "fallback", config: { kind: "noop" } }))).toEqual([]);
    expect(silent(gatingSpec({ kind: "review" }))).toEqual([]);
  });

  it("warns at /onUnavailable when the rule is fallback, whatever fallback config the bands carry", () => {
    const lows = [
      { kind: "fallback", config: { kind: "noop" } },
      { kind: "fallback" },
      { kind: "review" },
      { kind: "fallback", config: { kind: "value", value: "billing" } },
      { kind: "fallback", config: { kind: "set", setRef: "triage-backup" } },
    ] as const;
    for (const low of lows) {
      expect(silent({ ...gatingSpec(low), onUnavailable: "fallback" })).toEqual([
        { rule: "outage.fallback_silent", severity: "warning", path: "/onUnavailable", message: 'onUnavailable is fallback: on an outage "team" come back as fallback with no value, so the app decides on its own and nobody is told unless it says so; use review to send outages to a person' },
      ]);
    }
  });

  it("names gating composites too, and skips non-gating decisions", () => {
    const s: QuestionSetSpec = { ...gatingSpec({ kind: "review" }), onUnavailable: "fallback" };
    s.composites = [
      { id: "risk", kind: "weighted", terms: [{ q: "team", weight: 1, option: "billing" }], policy: { type: "composite", gating: true, levelThresholds: { high: 0.7, medium: 0.4 }, actions: { high: { kind: "review" }, medium: { kind: "review" }, low: { kind: "auto" } } } },
      { id: "soft", kind: "weighted", terms: [{ q: "team", weight: 1, option: "billing" }], policy: { type: "composite", gating: false, levelThresholds: { high: 0.7, medium: 0.4 }, actions: { high: { kind: "review" }, medium: { kind: "review" }, low: { kind: "auto" } } } },
    ];
    expect(silent(s)[0]?.message).toContain('"team", "risk" come back as fallback');
    const quiet = { ...minimal(), onUnavailable: "fallback" as const };
    expect(silent(quiet)).toEqual([]);
  });

  it("stays quiet on review and escalate_to_llm", () => {
    for (const onUnavailable of ["review", "escalate_to_llm"] as const) {
      expect(silent({ ...gatingSpec({ kind: "fallback", config: { kind: "noop" } }), onUnavailable })).toEqual([]);
    }
  });
});

describe("outage.auto_not_allowed", () => {
  it("passes every allowed outage rule and an omitted one", () => {
    for (const onUnavailable of [undefined, "fallback", "review", "escalate_to_llm"] as const) {
      const s = minimal();
      if (onUnavailable !== undefined) s.onUnavailable = onUnavailable;
      expect(rules(lint(s, jev))).not.toContain("outage.auto_not_allowed");
    }
  });

  it("names auto, and any other unknown value, at /onUnavailable", () => {
    const auto = minimal();
    (auto as { onUnavailable?: unknown }).onUnavailable = "auto";
    expect(lint(auto, jev).find((r) => r.rule === "outage.auto_not_allowed")).toMatchObject({ severity: "error", path: "/onUnavailable", message: expect.stringContaining("cannot be auto") });
    const other = minimal();
    (other as { onUnavailable?: unknown }).onUnavailable = "ignore";
    expect(lint(other, jev).find((r) => r.rule === "outage.auto_not_allowed")?.message).toContain("must be one of");
  });
});

describe("each rule fires on a minimal bad spec", () => {
  it.each(cases)("$rule", ({ rule, build }) => {
    const { spec, profile = jev, ctx } = build();
    const results = lint(spec, profile, ctx);
    for (const r of results) LintResult.parse(r);
    expect(rules(results)).toContain(rule);
  });

  it("every listed rule has a case", () => {
    const covered = new Set([...cases.map((c) => c.rule), "choice.too_many_options", "score.levels_range"]);
    expect(LINT_RULES.filter((r) => !covered.has(r))).toEqual([]);
  });
});

describe("rule details", () => {
  it("instructions.too_short says the question id never reaches the model", () => {
    const s = cases.find((c) => c.rule === "instructions.too_short")?.build().spec as QuestionSetSpec;
    expect(lint(s, jev).find((r) => r.rule === "instructions.too_short")).toEqual({
      rule: "instructions.too_short",
      severity: "warning",
      path: "/stages/0/questions/team/instructions",
      message:
        '"team" has fewer than 8 words of instructions; the question id is never sent to the model, so the requirement has to be in the instructions and option descriptions',
    });
  });

  it("weakness lints stay quiet when the profile does not list the weakness", () => {
    const counting = cases.find((c) => c.rule === "weakness.counting")?.build().spec as QuestionSetSpec;
    expect(rules(lint(counting, { ...jev, weaknesses: [] }))).not.toContain("weakness.counting");
    expect(rules(lint(counting, null))).not.toContain("weakness.counting");
  });

  it("publish-only rules are skipped without a PublishCtx", () => {
    const s = cases.find((c) => c.rule === "action.handler_unknown")?.build().spec as QuestionSetSpec;
    expect(rules(lint(s, jev))).not.toContain("action.handler_unknown");
  });

  it("model.deprecated is an error once retired", () => {
    const r = lint(minimal(), { ...jev, status: "retired" }).find((x) => x.rule === "model.deprecated");
    expect(r?.severity).toBe("error");
    expect(lint(minimal(), { ...jev, status: "deprecated", retireAt: null }).find((x) => x.rule === "model.deprecated")?.severity).toBe("warning");
  });

  it("model.not_available_to_org: preview without the opt-in, and no route on the provider", () => {
    expect(rules(lint({ ...minimal(), model: "jev-preview" }, preview, publishCtx()))).toContain("model.not_available_to_org");
    expect(rules(lint({ ...minimal(), model: "jev-preview" }, preview, publishCtx({ allowPreviewModels: true })))).not.toContain("model.not_available_to_org");
    const onOpenRouter = publishCtx({ systemOneProvider: "openrouter", modelRoutes: [] });
    expect(rules(lint(minimal(), jev, onOpenRouter))).toContain("model.not_available_to_org");
  });

  it("an unpinned OpenRouter route counts as moving past shadow; a pinned versioned model passes", () => {
    const ctx = publishCtx({ systemOneProvider: "openrouter", modelRoutes: [...SEED_MODEL_ROUTES], rolloutStage: "full" });
    expect(rules(lint(minimal(), jev, ctx))).toContain("model.alias_past_shadow");
    expect(rules(lint(minimal(), jev, publishCtx({ rolloutStage: "full" })))).not.toContain("model.alias_past_shadow");
    expect(rules(lint({ ...minimal(), model: "jev-latest" }, latest, publishCtx({ rolloutStage: "shadow" })))).not.toContain("model.alias_past_shadow");
  });

  it("fallback.set_invalid when the fallback set itself uses a set fallback", () => {
    const s = cases.find((c) => c.rule === "fallback.set_invalid")?.build().spec as QuestionSetSpec;
    const low = s.policies["team"]!.actions.low;
    expect(low.kind).toBe("fallback");
    const r = lint(s, jev, publishCtx({ fallbackSets: { nope: { usesSetFallback: true } } }));
    expect(rules(r)).toContain("fallback.set_invalid");
    expect(rules(lint(s, jev, publishCtx({ fallbackSets: { nope: { usesSetFallback: false } } })))).not.toContain("fallback.set_invalid");
  });

  it("escalation.model_unpriced falls back to the set comparator, and skips when neither is known", () => {
    const s = minimal();
    s.policies["team"] = { ...(s.policies["team"] as object), actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "escalate_to_llm" } } } as never;
    expect(rules(lint(s, jev, publishCtx()))).not.toContain("escalation.model_unpriced");
    expect(rules(lint({ ...s, savings: { comparatorModel: "gpt-x" } }, jev, publishCtx()))).toContain("escalation.model_unpriced");
  });

  it("interface.breaking clears with a bumped major or without consumers", () => {
    const built = cases.find((c) => c.rule === "interface.breaking")?.build();
    if (built?.ctx === undefined) throw new Error("no ctx");
    expect(rules(lint(built.spec, jev, { ...built.ctx, newMajor: 2 }))).not.toContain("interface.breaking");
    const noConsumers = { ...built.ctx, served: built.ctx.served.map((s) => ({ ...s, hasConsumers: false })) };
    expect(rules(lint(built.spec, jev, noConsumers))).not.toContain("interface.breaking");
  });

  it("stage lints: when reading a later answer and merging an unanswered question", () => {
    const s = minimal();
    s.stages[0]!.when = { q: "team", band: "high" };
    s.stages[0]!.stateFrom = { merge: { input: true, answers: ["team"] } };
    const r = lint(s, jev).filter((x) => x.rule === "stage.same_stage_dependency");
    expect(r.map((x) => x.path)).toEqual(["/stages/0/when", "/stages/0/stateFrom"]);
  });

  it("answers paths resolve only through a merge", () => {
    const s = minimal();
    s.stages.push({
      id: "second",
      stateFrom: { merge: { input: true, answers: ["team"] } },
      questions: {
        refund: { type: "noul", instructions: "Given `answers.team.value` and `answers.other.value`, does `ticket` ask for a refund?", meta: { label: "R" } },
      },
    });
    s.policies["refund"] = { type: "noul", gating: false, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
    const r = lint(s, jev).filter((x) => x.rule === "state_path.unknown");
    expect(r).toHaveLength(1);
    expect(r[0]?.message).toContain("answers.other");
  });

  it("a policy that names no question, and a question whose policy has another type", () => {
    const s = minimal();
    s.policies["ghost"] = s.policies["team"]!;
    s.policies["team"] = { type: "noul", gating: false, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } };
    const r = lint(s, jev).filter((x) => x.rule === "policy.type_mismatch").map((x) => x.path);
    expect(r).toEqual(["/policies/team/type", "/policies/ghost"]);
  });

  it("composite thresholds and per-option thresholds are checked for order", () => {
    const s = minimal();
    s.policies["team"] = { ...(s.policies["team"] as object), perOption: { billing: { high: 0.2, medium: 0.9 } } } as never;
    s.composites = [
      {
        id: "c",
        kind: "weighted",
        terms: [{ q: "team", weight: 1, option: "billing" }],
        policy: { type: "composite", gating: false, levelThresholds: { high: 0.1, medium: 0.5 }, actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } } },
      },
    ];
    const paths = lint(s, jev).filter((x) => x.rule === "policy.thresholds_order").map((x) => x.path);
    expect(paths).toEqual(["/policies/team/perOption/billing", "/composites/0/policy/levelThresholds"]);
  });

  it("backtick names of object-instruction fields are not state paths", () => {
    const s = minimal();
    s.stages[0]!.questions["team"]!.instructions = { candidate: { name: "Ana" }, question: "Is `candidate` the author of `ticket`, and which team should handle it?" };
    expect(rules(lint(s, jev))).not.toContain("state_path.unknown");
  });
});
