import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ON_UNAVAILABLE,
  OUTAGE_AUTO_NOT_ALLOWED_MESSAGE,
  OUTAGE_AUTO_NOT_ALLOWED_RULE,
  LintResult,
  onUnavailableOf,
  QuestionSetSpec,
  ROLLOUT_KEY_MESSAGE,
  RunDryRunResult,
  RunRequest,
  SetInterface,
  parseSpec,
  specQuestions,
  toJsonPointer,
} from "./spec.js";

const examplePath = new URL(
  "../../../../examples/email-triage.spec.json",
  import.meta.url,
);

function loadExample(): Record<string, unknown> {
  return JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;
}

/** A deep copy of the example that a test can mutate freely. */
function example(): Record<string, unknown> {
  return structuredClone(loadExample());
}

function failures(input: unknown) {
  const result = parseSpec(input);
  if (result.ok) throw new Error("expected the spec to fail");
  for (const detail of result.details) LintResult.parse(detail);
  return result.details;
}

const minimal = {
  schemaVersion: 1,
  model: "jev-1.13.0",
  input: { schema: { type: "object" } },
  stages: [
    {
      id: "main",
      questions: {
        is_spam: { type: "noul", instructions: "Is `email` spam?", meta: { label: "Spam" } },
      },
    },
  ],
  policies: {
    is_spam: {
      type: "noul",
      gating: true,
      noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
      actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
    },
  },
};

describe("QuestionSetSpec", () => {
  it("parses templates/question-set.example.json with parseSpec", () => {
    const result = parseSpec(loadExample());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.model).toBe("jev-1.13.0");
    expect(specQuestions(result.spec).map((q) => q.id)).toEqual([
      "real_person",
      "someone_waiting",
      "cost_of_ignoring",
      "category",
      "work_type",
    ]);
  });

  it("round-trips the example unchanged", () => {
    const parsed = QuestionSetSpec.parse(loadExample());
    expect(parsed).toEqual(loadExample());
  });

  it("parses a minimal spec", () => {
    expect(parseSpec(minimal).ok).toBe(true);
  });

  it("accepts each onUnavailable rule; omitted means review", () => {
    for (const rule of ["fallback", "review", "escalate_to_llm"] as const) {
      const r = parseSpec({ ...minimal, onUnavailable: rule });
      expect(r.ok && r.spec.onUnavailable).toBe(rule);
      if (r.ok) expect(onUnavailableOf(r.spec)).toBe(rule);
    }
    const plain = QuestionSetSpec.parse(minimal);
    expect(plain.onUnavailable).toBeUndefined();
    expect(onUnavailableOf(plain)).toBe(DEFAULT_ON_UNAVAILABLE);
    expect(DEFAULT_ON_UNAVAILABLE).toBe("review");
  });

  it("refuses onUnavailable auto with outage.auto_not_allowed, and other values with spec.invalid", () => {
    expect(failures({ ...minimal, onUnavailable: "auto" })).toEqual([
      { path: "/onUnavailable", rule: OUTAGE_AUTO_NOT_ALLOWED_RULE, severity: "error", message: OUTAGE_AUTO_NOT_ALLOWED_MESSAGE },
    ]);
    expect(failures({ ...minimal, onUnavailable: "ignore" })).toEqual([
      expect.objectContaining({ path: "/onUnavailable", rule: "spec.invalid" }),
    ]);
    // Another failure next to auto keeps its own rule.
    const both = failures({ ...minimal, onUnavailable: "auto", model: "" });
    expect(both.map((d) => d.rule).sort()).toEqual([OUTAGE_AUTO_NOT_ALLOWED_RULE, "spec.invalid"]);
    expect(failures(null)[0]?.rule).toBe("spec.invalid");
  });

  it("rejects a rollout key with spec.unknown_key at /rollout", () => {
    const details = failures({ ...example(), rollout: "full" });
    expect(details).toEqual([
      { path: "/rollout", rule: "spec.unknown_key", severity: "error", message: ROLLOUT_KEY_MESSAGE },
    ]);
  });

  it("reports nested unknown keys at their JSON Pointer", () => {
    const spec = example();
    const stages = spec["stages"] as Array<{ questions: Record<string, Record<string, unknown>> }>;
    const question = stages[0]?.questions["real_person"];
    if (question) question["weight"] = 2;
    const policies = spec["policies"] as Record<string, Record<string, unknown>>;
    const policy = policies["category"];
    if (policy) policy["rollout"] = "full";

    const details = failures(spec);
    expect(details).toContainEqual(
      expect.objectContaining({ path: "/stages/0/questions/real_person/weight", rule: "spec.unknown_key" }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ path: "/policies/category/rollout", rule: "spec.unknown_key" }),
    );
  });

  it("keeps free-form question meta and input.schema keys", () => {
    const spec = structuredClone(minimal);
    const withMeta = {
      ...spec,
      input: { schema: { type: "object", "x-anything": { deep: [1, 2] } } },
      stages: [
        {
          id: "main",
          questions: {
            is_spam: {
              type: "noul",
              instructions: "Is `email` spam?",
              meta: { label: "Spam", owner: "ops" },
            },
          },
        },
      ],
    };
    const parsed = QuestionSetSpec.parse(withMeta);
    expect(parsed.stages[0]?.questions["is_spam"]?.meta).toEqual({ label: "Spam", owner: "ops" });
  });

  it("rejects an unknown schemaVersion", () => {
    expect(failures({ ...minimal, schemaVersion: 2 })[0]).toMatchObject({
      path: "/schemaVersion",
      rule: "spec.invalid",
    });
  });

  it("rejects a question id that breaks the id pattern", () => {
    const spec = {
      ...minimal,
      stages: [{ id: "main", questions: { "Bad-Id": minimal.stages[0]?.questions.is_spam } }],
    };
    expect(parseSpec(spec).ok).toBe(false);
  });

  it("requires at least one stage and one question per stage", () => {
    expect(parseSpec({ ...minimal, stages: [] }).ok).toBe(false);
    expect(parseSpec({ ...minimal, stages: [{ id: "main", questions: {} }] }).ok).toBe(false);
  });

  it("rejects a question id used in two stages with spec.duplicate_id", () => {
    const stage = minimal.stages[0];
    const details = failures({ ...minimal, stages: [stage, { ...stage, id: "second" }] });
    expect(details).toEqual([
      expect.objectContaining({ path: "/stages/1/questions/is_spam", rule: "spec.duplicate_id" }),
    ]);
  });

  it("rejects a composite or check id that reuses a question id", () => {
    const details = failures({
      ...minimal,
      checks: [{ id: "is_spam", when: { input: "email.body", exists: true } }],
      composites: [{ id: "is_spam", kind: "weighted", terms: [{ q: "is_spam", weight: 1 }] }],
    });
    expect(details.map((d) => [d.path, d.rule])).toEqual([
      ["/composites/0/id", "spec.duplicate_id"],
      ["/checks/0/id", "spec.duplicate_id"],
    ]);
  });

  it("rejects a repeated stage id", () => {
    const other = {
      id: "main",
      questions: { other_q: { type: "noul", instructions: "Is it?", meta: { label: "Other" } } },
    };
    expect(failures({ ...minimal, stages: [minimal.stages[0], other] })).toEqual([
      expect.objectContaining({ path: "/stages/1/id", rule: "spec.duplicate_id" }),
    ]);
  });

  it("rejects escalate_to_llm in a composite policy", () => {
    const composite = {
      id: "urgency",
      kind: "weighted",
      terms: [{ q: "is_spam", weight: 1 }],
      policy: {
        type: "composite",
        gating: true,
        levelThresholds: { high: 0.7, medium: 0.4 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "escalate_to_llm" } },
      },
    };
    expect(parseSpec({ ...minimal, composites: [composite] }).ok).toBe(false);
    const allowed = {
      ...composite,
      policy: { ...composite.policy, actions: { ...composite.policy.actions, low: { kind: "auto" } } },
    };
    expect(parseSpec({ ...minimal, composites: [allowed] }).ok).toBe(true);
  });

  it("rejects a non-positive composite weight and an empty term list", () => {
    const base = { id: "urgency", kind: "weighted" };
    expect(parseSpec({ ...minimal, composites: [{ ...base, terms: [{ q: "is_spam", weight: 0 }] }] }).ok).toBe(
      false,
    );
    expect(parseSpec({ ...minimal, composites: [{ ...base, terms: [] }] }).ok).toBe(false);
  });

  it("accepts stateFrom input and merge forms", () => {
    const later = {
      id: "later",
      stateFrom: { merge: { input: true, answers: ["is_spam"], probabilities: true } },
      when: { q: "is_spam", eq: false },
      questions: { reply_needed: { type: "noul", instructions: "Does `email` need a reply?", meta: { label: "Reply" } } },
    };
    expect(parseSpec({ ...minimal, stages: [{ ...minimal.stages[0], stateFrom: "input" }, later] }).ok).toBe(true);
    const badMerge = { ...later, stateFrom: { merge: { input: false, answers: [] } } };
    expect(parseSpec({ ...minimal, stages: [minimal.stages[0], badMerge] }).ok).toBe(false);
  });

  it("validates routes, defaultRoute and savings", () => {
    expect(
      parseSpec({
        ...minimal,
        routes: [{ when: { q: "is_spam", eq: true }, output: "spam" }],
        defaultRoute: "inbox",
        savings: { kind: "context_pruned", estOutputTokensPerQuestion: 40 },
      }).ok,
    ).toBe(true);
    expect(parseSpec({ ...minimal, savings: { kind: "free_lunch" } }).ok).toBe(false);
    expect(parseSpec({ ...minimal, routes: [{ when: { q: "is_spam", eq: true } }] }).ok).toBe(false);
  });
});

describe("toJsonPointer", () => {
  it("escapes ~ and / per RFC 6901", () => {
    expect(toJsonPointer([])).toBe("");
    expect(toJsonPointer(["a/b", "c~d", 0])).toBe("/a~1b/c~0d/0");
  });
});

describe("SetInterface", () => {
  it("parses the interface of the example spec", () => {
    const iface = {
      inputSchema: { type: "object" },
      questions: [
        { id: "category", type: "choice", options: ["work_request", "none_of_these"] },
        { id: "cost_of_ignoring", type: "score", levels: 4 },
        { id: "real_person", type: "noul" },
      ],
      composites: ["urgency"],
      routeOutputs: ["urgent", "read_later", "normal"],
    };
    expect(SetInterface.parse(iface)).toEqual(iface);
    expect(SetInterface.safeParse({ ...iface, questions: [{ id: "x", type: "rank" }] }).success).toBe(false);
  });
});

describe("RunRequest", () => {
  it("parses the request the route adapter builds", () => {
    const req = {
      setRef: "email-triage",
      channel: "production",
      state: { email: { from: "ana@example.com", subject: "Re: contract", body: "..." } },
      source: "api",
      options: { externalRef: "msg_8812" },
      idempotencyKey: "01J9Z3",
      interfaceMajor: 2,
    };
    expect(RunRequest.parse(req)).toEqual(req);
  });

  it("accepts a draft version and rejects unknown sources, channels and keys", () => {
    const base = { setRef: "s", state: {}, source: "cli", options: {} };
    expect(RunRequest.safeParse({ ...base, version: "draft" }).success).toBe(true);
    expect(RunRequest.safeParse({ ...base, version: 0 }).success).toBe(false);
    expect(RunRequest.safeParse({ ...base, source: "ingest" }).success).toBe(false);
    expect(RunRequest.safeParse({ ...base, channel: "pinned" }).success).toBe(false);
    expect(RunRequest.safeParse({ ...base, rollout: "full" }).success).toBe(false);
    expect(RunRequest.safeParse({ setRef: "s", state: {}, source: "cli" }).success).toBe(false);
  });
});

describe("RunDryRunResult", () => {
  const sample = {
    dryRun: true,
    setId: "01926f3e-8a1b-7c2d-9e4f-5a6b7c8d9e0f",
    versionId: "01926f3e-8a1b-7c2d-9e4f-5a6b7c8d9e10",
    version: "draft",
    model: "jev-latest",
    profileId: "jev-1.13.0",
    provider: "typesafe",
    stages: [
      {
        id: "triage",
        skipped: false,
        batches: [
          {
            request: {
              state: { email: { subject: "Hi" } },
              model: "jev-latest",
              questions: { real_person: { type: "noul", instructions: "Was `email` written by a person?" } },
            },
            estTokens: 318,
          },
        ],
      },
    ],
    limits: { requestTokens: 64000, statePlusLongestQuestionTokens: 32000 },
    warnings: ["dry_run_answers_unknown"],
  };

  it("parses a sample and requires dryRun true", () => {
    expect(RunDryRunResult.parse(sample)).toEqual(sample);
    expect(RunDryRunResult.safeParse({ ...sample, dryRun: false }).success).toBe(false);
  });
});
