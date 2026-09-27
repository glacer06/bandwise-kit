import { describe, expect, it } from "vitest";
import { RunDryRunResult, type QuestionSetSpec } from "../contracts/spec.js";
import { RunResult } from "../contracts/run.js";
import { RunSinkRecord, type LlmTransport, type RunPorts } from "../contracts/ports.js";
import type { SystemOneResponse } from "../contracts/system-one.js";
import { SEED_COMPARATOR_PRICES, SEED_MODEL_PROFILES, SEED_MODEL_ROUTES } from "../models/catalog.js";
import { createMemoryModelCatalog, createMemoryPriceBook, staticKeyResolver, steppingClock } from "../memory/ports.js";
import {
  EXAMPLE_ANSWERS,
  answersFrom,
  control,
  exampleSpec,
  exampleState,
  makePorts,
  resolvedRun,
  runRequest,
  scriptedTransport,
  transportError,
  userCtx,
} from "../test/harness.js";
import { isRunRefusedError } from "./errors.js";
import { dryRunQuestionSet, isOutageCode, isOutageRun, priceCall, runQuestionSet } from "./run.js";

const ctx = userCtx();

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isRunRefusedError(e)) return e.code;
    throw e;
  }
  throw new Error("expected the run to be refused");
}

describe("runQuestionSet end to end on the example spec", () => {
  it("returns a valid RunResult with bands, actions, cost and savings", async () => {
    const h = makePorts();
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control());
    expect(RunResult.parse(result)).toBeTruthy();
    expect(result).toMatchObject({
      status: "ok",
      rollout: "full",
      modelRequested: "jev-1.13.0",
      modelResolved: "jev-1.13.0",
      typesafeRequestId: "req_1",
      runBand: "high",
      overallAction: "auto",
      route: "urgent",
    });
    expect(result.decisions["urgency"]).toMatchObject({ kind: "composite", level: "high", band: "high" });
    // 318 input tokens on jev-1.13.0: 13 micro-USD.
    expect(result.cost.systemOneCostUsd).toBe(0.000013);
    expect(result.cost.comparatorModel).toBe("claude-haiku-4-5");
    expect(result.cost.savingsKind).toBe("decision");
    expect(result.cost.savingsSuppressed).toBeNull();
    expect(result.cost.counterfactualOutputTokens).toBe(5 * 60);
    expect(result.cost.savingsUsd).toBeGreaterThan(0);
    expect(result.cost.llmCallsAvoided).toBe(1);
    expect(result.cost.estimated).toBe(true);
    expect(result.warnings).toEqual([]);

    // The request sent redacts email.signature; the stored state is full (piiMode off).
    const sent = (h.transport as ReturnType<typeof scriptedTransport>).calls[0];
    expect(JSON.stringify(sent?.req.state)).toContain("[redacted]");
    expect(sent?.opts).toMatchObject({ provider: "typesafe", apiKey: "ts_test_key", retry: { maxRetries: 2 } });
    const record = h.runs.records[0];
    expect(RunSinkRecord.parse(record)).toBeTruthy();
    expect(JSON.stringify(record?.state)).toContain("+1 555 0100");
    expect(record?.keyMode).toBe("byo");
    expect(record?.provider).toBe("typesafe");
  });

  it("shadow: every effective action is fallback and savings are suppressed but counted", async () => {
    const h = makePorts();
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { rollout: "shadow" }), h.ports, control());
    expect(Object.values(result.decisions).every((d) => d.effectiveAction === "fallback")).toBe(true);
    expect(result.overallAction).toBe("fallback");
    expect(result.cost.savingsSuppressed).toBe("shadow");
    expect(result.cost.savingsUsd).toBe(0);
    expect(result.cost.counterfactualLlmCostUsd).toBeGreaterThan(0);
    expect(result.reviewItemIds).toBeUndefined();
  });

  it("controlled: medium gating decisions go to review and create review items", async () => {
    const answers = { ...EXAMPLE_ANSWERS, someone_waiting: { type: "noul", noul: 0.8 } };
    const h = makePorts({ transport: scriptedTransport(answersFrom(answers)) });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { rollout: "controlled" }), h.ports, control());
    expect(result.decisions["someone_waiting"]).toMatchObject({ band: "medium", effectiveAction: "review", executed: true });
    expect(result.overallAction).toBe("review");
    expect(result.reviewItemIds?.length).toBeGreaterThan(0);
  });

  it("staging, eval and challenger runs book no savings", async () => {
    const staging = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { channel: "staging" }), makePorts().ports, control());
    expect(staging.cost.savingsSuppressed).toBe("staging");
    let bucket = "";
    const h = makePorts({
      limiter: async (_c, _m, _t, b) => {
        bucket = b;
        return { ok: true };
      },
    });
    const evalRun = await runQuestionSet(ctx, runRequest(exampleState(), { source: "eval" }), resolvedRun(exampleSpec()), h.ports, control());
    expect(evalRun.cost.savingsSuppressed).toBe("eval");
    expect(bucket).toBe("eval");
    const challenger = await runQuestionSet(
      ctx,
      runRequest(exampleState()),
      resolvedRun(exampleSpec(), { experiment: { id: "01890000-0000-7000-8000-0000000000e1", arm: "challenger" } }),
      makePorts().ports,
      control(),
    );
    expect(challenger.cost.savingsSuppressed).toBe("experiment");
    expect(challenger.experiment?.arm).toBe("challenger");
  });

  it("storage modes: hash_only stores no state, redacted stores the redacted copy", async () => {
    const hashOnly = makePorts();
    await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { settings: { storageMode: "hash_only" } }), hashOnly.ports, control());
    expect(hashOnly.runs.records[0]?.state).toBeNull();
    expect(hashOnly.runs.records[0]?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    const redacted = makePorts();
    await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { settings: { storageMode: "redacted" } }), redacted.ports, control());
    expect(JSON.stringify(redacted.runs.records[0]?.state)).toContain("[redacted]");
  });

  it("uses the Redactor port when one is given", async () => {
    const h = makePorts({ redactor: (state, paths, mode) => ({ redactedBy: "port", paths, mode, state: typeof state }) });
    await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control());
    const sent = (h.transport as ReturnType<typeof scriptedTransport>).calls[0];
    expect(sent?.req.state).toEqual({ redactedBy: "port", paths: ["email.signature"], mode: "off", state: "object" });
  });
});

describe("refusals before a run row exists", () => {
  it("an inactive channel is 409 set_not_live; slug@draft still runs as shadow", async () => {
    const h = makePorts();
    expect(await refused(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { rollout: "inactive" }), h.ports, control()))).toBe(
      "set_not_live",
    );
    const draft = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec(), { rollout: "inactive", channel: "draft" }), h.ports, control());
    expect(draft.rollout).toBe("shadow");
    expect(h.runs.records).toHaveLength(1);
  });

  it("an interface major mismatch", async () => {
    const code = await refused(runQuestionSet(ctx, runRequest(exampleState(), { interfaceMajor: 2 }), resolvedRun(exampleSpec()), makePorts().ports, control()));
    expect(code).toBe("interface_mismatch");
  });

  it("invalid state, with details", async () => {
    try {
      await runQuestionSet(ctx, runRequest({ email: { from: 1 } }), resolvedRun(exampleSpec()), makePorts().ports, control());
      throw new Error("expected invalid_state");
    } catch (e) {
      if (!isRunRefusedError(e)) throw e;
      expect(e.code).toBe("invalid_state");
      expect(e.details?.map((d) => d.path)).toContain("/me");
    }
  });

  it("an unknown or unreviewed model is model_unavailable, except unreviewed in the playground", async () => {
    const unknown = { ...exampleSpec(), model: "foo-2.0.0" };
    expect(await refused(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(unknown), makePorts().ports, control()))).toBe("model_unavailable");
    const jev = SEED_MODEL_PROFILES[0];
    if (jev === undefined) throw new Error("no seed");
    const models = createMemoryModelCatalog([{ ...jev, id: "new-1.0.0", status: "unreviewed" }, ...SEED_MODEL_PROFILES]);
    const spec = { ...exampleSpec(), model: "new-1.0.0" };
    expect(await refused(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(spec), makePorts({ models }).ports, control()))).toBe("model_unavailable");
    const prices = createMemoryPriceBook([{ model: "new-1.0.0", inputPerMtokMicroUsd: 1, outputPerMtokMicroUsd: 0 }, ...SEED_COMPARATOR_PRICES]);
    const played = await runQuestionSet(ctx, runRequest(exampleState(), { source: "playground" }), resolvedRun(spec), makePorts({ models, prices }).ports, control());
    expect(played.status).toBe("ok");
    const retired = createMemoryModelCatalog([{ ...jev, status: "retired" }]);
    expect(await refused(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), makePorts({ models: retired }).ports, control()))).toBe(
      "model_unavailable",
    );
  });

  it("a model with no route on the provider is model_unavailable", async () => {
    const spec = { ...exampleSpec(), model: "jev-preview" };
    const code = await refused(
      runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(spec, { settings: { systemOneProvider: "openrouter" } }), makePorts().ports, control()),
    );
    expect(code).toBe("model_unavailable");
  });

  it("a stage over the model limits is preflight_too_large", async () => {
    const spec = exampleSpec();
    spec.input.maxStateTokens = 10;
    expect(await refused(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(spec), makePorts().ports, control()))).toBe("preflight_too_large");
  });

  it("a platform key run on an unpriced model is model_unpriced", async () => {
    const h = makePorts({ keys: staticKeyResolver({ typesafe: "platform" }, "platform"), prices: createMemoryPriceBook(SEED_COMPARATOR_PRICES) });
    expect(await refused(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control()))).toBe("model_unpriced");
  });

  it("a dry run request goes through dryRunQuestionSet", async () => {
    const code = await refused(runQuestionSet(ctx, runRequest(exampleState(), { options: { dryRun: true } }), resolvedRun(exampleSpec()), makePorts().ports, control()));
    expect(code).toBe("invalid_request");
  });

  it("does not swallow unexpected errors from ports", async () => {
    const h = makePorts({
      keys: async () => {
        throw new Error("boom");
      },
    });
    await expect(runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control())).rejects.toThrow("boom");
  });
});

describe("failed runs return the envelope with status and error", () => {
  it.each([
    ["system_one_rate_limited", "system_one_rate_limited"],
    ["system_one_auth", "system_one_auth"],
  ] as const)("a transport %s fails the run with %s and no decisions", async (thrown, code) => {
    const h = makePorts({ transport: scriptedTransport(() => transportError(thrown)) });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control());
    expect(RunResult.parse(result)).toBeTruthy();
    expect(result).toMatchObject({ status: "error", error: { code }, decisions: {}, runBand: "low", overallAction: "fallback", modelResolved: null });
    expect(result.warnings).not.toContain("system_one_outage");
    expect(isOutageRun(result)).toBe(false);
    expect(h.runs.records).toHaveLength(1);
  });

  it.each([
    ["client_aborted", "system_one_unavailable"],
    ["llm_unavailable", "system_one_unavailable"],
    ["system_one_unavailable", "system_one_unavailable"],
    ["system_one_overloaded", "system_one_overloaded"],
  ] as const)("a transport %s is an outage with %s and decisions from the outage rule", async (thrown, code) => {
    const h = makePorts({ transport: scriptedTransport(() => transportError(thrown, true)) });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control());
    expect(RunResult.parse(result)).toBeTruthy();
    expect(result).toMatchObject({ status: "error", error: { code }, runBand: "low", overallAction: "review", modelResolved: null, route: null });
    expect(Object.keys(result.decisions).length).toBeGreaterThan(0);
    expect(isOutageRun(result)).toBe(true);
    expect(isOutageCode(code)).toBe(true);
    expect(h.runs.records).toHaveLength(1);
  });

  it("a non-transport error from the transport is system_one_unavailable", async () => {
    const h = makePorts({ transport: scriptedTransport(() => new Error("socket")) });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control());
    expect(result.error?.code).toBe("system_one_unavailable");
  });

  it("an exhausted latency budget or an aborted signal is system_one_unavailable", async () => {
    const slow = makePorts({ clock: steppingClock(0, 10_000) });
    const r1 = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), slow.ports, control(8_000));
    expect(r1.error?.code).toBe("system_one_unavailable");
    const aborted = makePorts();
    const r2 = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), aborted.ports, control(8_000, { aborted: true } as AbortSignal));
    expect(r2.error?.code).toBe("system_one_unavailable");
    expect((aborted.transport as ReturnType<typeof scriptedTransport>).calls).toHaveLength(0);
  });

  it("the limiter and the quota guard", async () => {
    const limited = makePorts({ limiter: async () => ({ ok: false, retryAfterMs: 100, reason: "org" }) });
    const r1 = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), limited.ports, control());
    expect(r1).toMatchObject({ status: "rate_limited", error: { code: "rate_limited" } });
    const quota = makePorts({ quota: async () => ({ ok: false, code: "token_budget_exceeded" }) });
    const r2 = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), quota.ports, control());
    expect(r2).toMatchObject({ status: "quota_exceeded", error: { code: "token_budget_exceeded" } });
  });

  it("a missing key is system_one_auth", async () => {
    const h = makePorts({ keys: staticKeyResolver({}) });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports, control());
    expect(result.error?.code).toBe("system_one_auth");
  });
});

const twoStage: QuestionSetSpec = {
  schemaVersion: 1,
  model: "jev-latest",
  input: { schema: { type: "object", properties: { ticket: { type: "string" } } } },
  checks: [{ id: "has_ticket", when: { input: "ticket", exists: true } }],
  stages: [
    {
      id: "classify",
      questions: {
        team: {
          type: "choice",
          instructions: "Which team should handle `ticket`?",
          criteria: { billing: "Payments", technical: "Bugs", none: null },
          meta: { label: "Team" },
        },
      },
    },
    {
      id: "billing_detail",
      when: { q: "team", eq: "billing" },
      stateFrom: { merge: { input: true, answers: ["team"], probabilities: true } },
      questions: {
        refund: {
          type: "noul",
          instructions: "Given the team is `answers.team.value`, does `ticket` ask for a refund?",
          meta: { label: "Refund" },
        },
      },
    },
  ],
  policies: {
    team: { type: "choice", gating: true, thresholds: { high: 0.75, medium: 0.45 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } },
    refund: {
      type: "noul",
      gating: true,
      noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
      actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
    },
  },
};

const teamAnswer = (choice: string) => ({ type: "choice", choice, confidence: 0.9, probabilities: { billing: 0.9, technical: 0.05, none: 0.05 } });

describe("stages", () => {
  it("merges earlier answers into later state and records one call per stage; an alias is priced by the resolved model", async () => {
    const transport = scriptedTransport((req, n) => {
      const answers = n === 1 ? { team: teamAnswer("billing") } : { refund: { type: "noul", noul: 0.95 } };
      return { model: n === 1 ? "jev-1.13.0" : "jev-1.14.0", answers, usage: { input_tokens: 100, output_tokens: 10 } } as unknown as SystemOneResponse;
    });
    const h = makePorts({ transport });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "I was charged twice" }), resolvedRun(twoStage), h.ports, control());
    expect(result.stages.map((s) => [s.id, s.skipped, s.calls.length])).toEqual([
      ["classify", false, 1],
      ["billing_detail", false, 1],
    ]);
    expect(transport.calls[0]?.req.model).toBe("jev-latest");
    expect(transport.calls[1]?.req.state).toEqual({
      ticket: "I was charged twice",
      answers: { team: { value: "billing", band: "high", probabilities: { billing: 0.9, technical: 0.05, none: 0.05 } } },
    });
    expect(result.modelResolved).toBe("jev-1.13.0");
    expect(result.checks).toEqual({ has_ticket: true });
    // Mixed builds: the second call's model has no price row, so the run is unpriced (BYO).
    expect(result.warnings).toEqual(expect.arrayContaining(["model_resolved_mixed", "model_unpriced"]));
    expect(result.cost.systemOneCostUsd).toBeNull();
    expect(result.cost.systemOneInputTokens).toBe(200);
    expect(RunResult.parse(result)).toBeTruthy();
  });

  it("skips a stage whose when is false; its questions are skipped decisions with no answers entry", async () => {
    const transport = scriptedTransport(() => ({ model: "jev-1.13.0", answers: { team: teamAnswer("technical") }, usage: { input_tokens: 50, output_tokens: 5 } }) as SystemOneResponse);
    const h = makePorts({ transport });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "App crashes" }), resolvedRun(twoStage), h.ports, control());
    expect(result.stages[1]).toEqual({ id: "billing_detail", skipped: true, calls: [] });
    expect(result.answers["refund"]).toBeUndefined();
    expect(result.decisions["refund"]).toEqual({ kind: "question", value: null, band: "low", relevant: false, action: "fallback", effectiveAction: "fallback", executed: false });
    expect(transport.calls).toHaveLength(1);
    expect(RunSinkRecord.parse(h.runs.records[0])).toBeTruthy();
  });

  it("a stage that fails preflight after an earlier call fails the run", async () => {
    const spec = structuredClone(twoStage);
    spec.input.maxStateTokens = 20;
    const transport = scriptedTransport(() => ({ model: "jev-1.13.0", answers: { team: teamAnswer("billing") }, usage: { input_tokens: 50, output_tokens: 5 } }) as SystemOneResponse);
    const result = await runQuestionSet(ctx, runRequest({ ticket: "refund" }), resolvedRun(spec), makePorts({ transport }).ports, control());
    expect(result.error?.code).toBe("preflight_too_large");
    expect(result.stages[0]?.calls).toHaveLength(1);
  });

  it("dry run compiles and preflights without calls, rows or limiter tokens", async () => {
    let limiterCalls = 0;
    const h = makePorts({
      limiter: async () => {
        limiterCalls += 1;
        return { ok: true };
      },
    });
    const dry = await dryRunQuestionSet(ctx, runRequest({ ticket: "x" }, { options: { dryRun: true } }), resolvedRun(twoStage, { channel: "draft" }), h.ports);
    expect(RunDryRunResult.parse(dry)).toBeTruthy();
    expect(dry).toMatchObject({ dryRun: true, version: "draft", model: "jev-latest", profileId: "jev-1.13.0", provider: "typesafe" });
    expect(dry.limits).toEqual({ requestTokens: 64_000, statePlusLongestQuestionTokens: 32_000 });
    expect(dry.warnings).toContain("dry_run_answers_unknown");
    expect(dry.stages.map((s) => s.batches.length)).toEqual([1, 1]);
    expect((h.transport as ReturnType<typeof scriptedTransport>).calls).toHaveLength(0);
    expect(h.runs.records).toHaveLength(0);
    expect(limiterCalls).toBe(0);
    const pinned = await dryRunQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), h.ports);
    expect(pinned.version).toBe(3);
    expect(pinned.warnings).toEqual([]);
  });

  it("a stage skipped on input and checks alone shows as skipped in a dry run", async () => {
    const spec: QuestionSetSpec = { ...structuredClone(twoStage), stages: [{ ...structuredClone(twoStage.stages[0]!), when: { check: "has_ticket" } }] };
    const dry = await dryRunQuestionSet(ctx, runRequest({}), resolvedRun({ ...spec, policies: { team: twoStage.policies["team"]! } }), makePorts().ports);
    expect(dry.stages[0]).toEqual({ id: "classify", skipped: true, batches: [] });
  });
});

describe("OpenRouter route", () => {
  const orResponse = (model: string, cost?: number) =>
    ({
      id: "gen-dec-1",
      model,
      provider: "TypeSafe",
      answers: { team: teamAnswer("technical") },
      usage: cost === undefined ? { input_tokens: 476, output_tokens: 70 } : { input_tokens: 476, output_tokens: 70, cost },
    }) as SystemOneResponse;

  const oneStage: QuestionSetSpec = { ...twoStage, model: "jev-1.13.0", stages: [twoStage.stages[0]!], policies: { team: twoStage.policies["team"]! } };

  it("sends the route id, stores the OpenRouter id, and prices from usage.cost", async () => {
    const transport = scriptedTransport(() => orResponse("typesafe/jev-1.13-20260917", 0.000019992), () => "gen-dec-1");
    const h = makePorts({ transport });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(oneStage, { settings: { systemOneProvider: "openrouter" } }), h.ports, control());
    expect(transport.calls[0]?.req.model).toBe("typesafe/jev-1.13");
    expect(transport.calls[0]?.opts).toMatchObject({ provider: "openrouter", apiKey: "or_test_key" });
    expect(result.modelResolved).toBe("typesafe/jev-1.13-20260917");
    expect(result.typesafeRequestId).toBe("gen-dec-1");
    expect(result.stages[0]?.calls[0]).toMatchObject({ provider: "openrouter", providerCostUsd: 0.00002 });
    expect(result.cost.systemOneCostUsd).toBe(0.00002);
    expect(result.warnings).toEqual([]);
    expect(h.runs.records[0]?.provider).toBe("openrouter");
  });

  it("warns model_resolved_unmapped when no route knows the response model, and prices it only if reported", async () => {
    const transport = scriptedTransport(() => orResponse("typesafe/jev-9"));
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(oneStage, { settings: { systemOneProvider: "openrouter" } }), makePorts({ transport }).ports, control());
    expect(result.warnings).toEqual(expect.arrayContaining(["model_resolved_unmapped", "model_unpriced"]));
    expect(result.cost.systemOneCostUsd).toBeNull();
  });

  it("a mapped response without usage.cost is priced from the price book row of its registry id", async () => {
    const transport = scriptedTransport(() => orResponse("typesafe/jev-1.13-20260917"));
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(oneStage, { settings: { systemOneProvider: "openrouter" } }), makePorts({ transport }).ports, control());
    expect(result.cost.systemOneCostUsd).toBe(0.00002); // round_half_up(476 * 42000 / 1e6) = 20
  });

  it("platform key mode on OpenRouter does not need a price row (usage.cost is the charge)", async () => {
    const transport = scriptedTransport(() => orResponse("typesafe/jev-1.13-20260917", 0.00002));
    const h = makePorts({ transport, keys: staticKeyResolver({ openrouter: "platform" }, "platform"), prices: createMemoryPriceBook(SEED_COMPARATOR_PRICES) });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(oneStage, { settings: { systemOneProvider: "openrouter" } }), h.ports, control());
    expect(result.status).toBe("ok");
    expect(h.runs.records[0]?.keyMode).toBe("platform");
  });

  it("on Vercel sends typesafe-ai/jev for jev-latest and prices from provider_metadata.gateway.cost", async () => {
    const latest: QuestionSetSpec = { ...oneStage, model: "jev-latest" };
    const transport = scriptedTransport(() => ({
      model: "typesafe-ai/jev",
      answers: { team: teamAnswer("technical") },
      usage: { input_tokens: 275, output_tokens: 20 },
      provider_metadata: { gateway: { cost: "0.00001155" } },
    }) as SystemOneResponse);
    const h = makePorts({ transport });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(latest, { settings: { systemOneProvider: "vercel" } }), h.ports, control());
    expect(transport.calls[0]?.req.model).toBe("typesafe-ai/jev");
    expect(transport.calls[0]?.opts).toMatchObject({ provider: "vercel", apiKey: "vg_test_key" });
    expect(result.stages[0]?.calls[0]).toMatchObject({ provider: "vercel", providerCostUsd: 0.000012 });
    expect(result.cost.systemOneCostUsd).toBe(0.000012);
    expect(result.warnings).not.toContain("model_resolved_unmapped");
  });

  it("priceCall reads providerCostUsd first", () => {
    expect(priceCall({ inputTokens: 476, outputTokens: 70, providerCostUsd: 0.00002 }, null)).toBe(20);
    expect(priceCall({ inputTokens: 318, outputTokens: 0 }, { inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 })).toBe(13);
  });
});

describe("outage rule", () => {
  const withRule = (onUnavailable?: QuestionSetSpec["onUnavailable"]): QuestionSetSpec => {
    const spec = exampleSpec();
    if (onUnavailable !== undefined) spec.onUnavailable = onUnavailable;
    return spec;
  };
  const down = () => scriptedTransport(() => transportError("system_one_unavailable", true));
  const gatingIds = (spec: QuestionSetSpec) =>
    Object.entries(spec.policies).filter(([, p]) => p.gating).map(([id]) => id);

  it.each([
    [undefined, "review"],
    ["fallback", "fallback"],
    ["review", "review"],
  ] as const)("onUnavailable %s: every gating decision is %s, band low, never auto", async (rule, action) => {
    const spec = withRule(rule);
    const h = makePorts({ transport: down() });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(spec), h.ports, control());
    expect(RunResult.parse(result)).toBeTruthy();
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("system_one_unavailable");
    expect(result.warnings).toContain("system_one_outage");
    for (const id of gatingIds(spec)) {
      if (result.decisions[id]?.relevant === false) continue;
      expect(result.decisions[id]).toMatchObject({ band: "low", value: null, effectiveAction: action });
    }
    expect(Object.values(result.decisions).some((d) => d.effectiveAction === "auto")).toBe(false);
    expect(result.overallAction).toBe(action);
    expect(result.runBand).toBe("low");
    // Savings are suppressed; outage runs are excluded from calibration.
    expect(result.cost).toMatchObject({ savingsSuppressed: "outage", savingsUsd: 0, llmCallsAvoided: 0 });
    expect(isOutageRun(result)).toBe(true);
    if (action === "review") expect(result.reviewItemIds?.length).toBeGreaterThan(0);
    else expect(result.reviewItemIds).toBeUndefined();
  });

  it("shadow never acts on an outage: every decision is fallback", async () => {
    const h = makePorts({ transport: down() });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(withRule("review"), { rollout: "shadow" }), h.ports, control());
    expect(Object.values(result.decisions).every((d) => d.effectiveAction === "fallback" && !d.executed)).toBe(true);
    expect(result.cost.savingsSuppressed).toBe("outage");
  });

  it("an exhausted latency budget is an outage too", async () => {
    const h = makePorts({ clock: steppingClock(0, 10_000) });
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(withRule("review")), h.ports, control(8_000));
    expect(result.error?.code).toBe("system_one_unavailable");
    expect(result.overallAction).toBe("review");
  });

  it("a later stage outage keeps earlier answers and skipped stages, and every decision takes the rule", async () => {
    const transport = scriptedTransport((_req, n) =>
      n === 1 ? ({ model: "jev-1.13.0", answers: { team: teamAnswer("billing") }, usage: { input_tokens: 100, output_tokens: 5 } } as SystemOneResponse) : transportError("system_one_overloaded", true),
    );
    const h = makePorts({ transport });
    const spec = { ...structuredClone(twoStage), onUnavailable: "review" as const };
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(spec), h.ports, control());
    expect(RunResult.parse(result)).toBeTruthy();
    expect(result.error?.code).toBe("system_one_overloaded");
    expect(result.answers["team"]).toBeDefined();
    expect(result.modelResolved).toBe("jev-1.13.0");
    expect(result.decisions["team"]).toMatchObject({ value: null, band: "low", effectiveAction: "review" });
    expect(result.decisions["refund"]).toMatchObject({ effectiveAction: "review" });
    expect(result.cost.savingsUsd).toBe(0);
    expect(result.cost.systemOneInputTokens).toBe(100);

    const skipping = makePorts({ transport: scriptedTransport((_req, n) => (n === 1 ? ({ model: "jev-1.13.0", answers: { team: teamAnswer("technical") }, usage: { input_tokens: 100, output_tokens: 5 } } as SystemOneResponse) : transportError("system_one_unavailable"))) });
    const twoFail = { ...spec, stages: [...spec.stages, { id: "third", questions: { third: { type: "noul" as const, instructions: "Is `ticket` about an invoice at all, in any way?", meta: { label: "Third" } } } }], policies: { ...spec.policies, third: spec.policies["refund"]! } };
    const r2 = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(twoFail), skipping.ports, control());
    expect(r2.stages.map((s) => s.skipped)).toEqual([false, true, false]);
    expect(r2.decisions["refund"]).toMatchObject({ relevant: false, effectiveAction: "fallback" });
    expect(r2.decisions["third"]).toMatchObject({ effectiveAction: "review" });
  });

  describe("escalate_to_llm on an outage", () => {
    const answerLlm = (text: string | Error): LlmTransport & { requests: unknown[] } => {
      const requests: unknown[] = [];
      return {
        requests,
        async complete(req) {
          requests.push(req);
          if (text instanceof Error) throw text;
          return { text, model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 2 };
        },
      };
    };
    const single = (): QuestionSetSpec => {
      const spec = structuredClone(twoStage);
      spec.stages = [spec.stages[0]!];
      spec.policies = { team: spec.policies["team"]! };
      spec.onUnavailable = "escalate_to_llm";
      return spec;
    };

    it("goes through ports.llm like a normal escalation and books its cost, not savings", async () => {
      const port = answerLlm("technical");
      const h = makePorts({ transport: down(), llm: port });
      const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(single()), h.ports, control());
      expect(RunResult.parse(result)).toBeTruthy();
      expect(result.decisions["team"]).toMatchObject({
        value: null,
        band: "low",
        effectiveAction: "escalate_to_llm",
        executed: true,
        escalation: { model: "claude-haiku-4-5", value: "technical", status: "ok" },
      });
      expect(port.requests).toHaveLength(1);
      expect(result.cost).toMatchObject({ llmCallsMade: 1, escalationCostUsd: 0.00031, savingsSuppressed: "outage", savingsUsd: 0 });
      expect(result.overallAction).toBe("escalate_to_llm");
    });

    it.each([
      ["no LLM port", undefined],
      ["an LLM failure", answerLlm(transportError("llm_unavailable"))],
    ])("falls back to review on %s", async (_name, port) => {
      const h = makePorts({ transport: down(), ...(port === undefined ? {} : { llm: port }) });
      const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(single()), h.ports, control());
      expect(result.decisions["team"]).toMatchObject({ effectiveAction: "review", executed: true, escalation: { status: "failed" } });
      expect(result.warnings).toEqual(expect.arrayContaining(["system_one_outage", "escalation_failed"]));
      expect(result.reviewItemIds).toHaveLength(1);
    });
  });
});

describe("escalate_to_llm", () => {
  const escalating = (): QuestionSetSpec => {
    const spec = structuredClone(twoStage);
    spec.stages = [spec.stages[0]!];
    spec.policies = {
      team: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.95, medium: 0.5 },
        actions: { high: { kind: "auto" }, medium: { kind: "escalate_to_llm", config: { model: "claude-haiku-4-5", maxOutputTokens: 16 } }, low: { kind: "review" } },
      },
    };
    return spec;
  };
  const llm = (text: string | Error): LlmTransport & { requests: unknown[] } => {
    const requests: unknown[] = [];
    return {
      requests,
      async complete(req) {
        requests.push(req);
        if (text instanceof Error) throw text;
        return { text, model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 2 };
      },
    };
  };
  const answer = scriptedTransport(() => ({ model: "jev-1.13.0", answers: { team: teamAnswer("billing") }, usage: { input_tokens: 100, output_tokens: 5 } }) as SystemOneResponse);

  it("calls the LLM, keeps the System One value, and books the escalation cost", async () => {
    const port = llm(" technical\n");
    const h = makePorts({ transport: answer, llm: port });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(escalating()), h.ports, control());
    expect(result.decisions["team"]).toMatchObject({
      value: "billing",
      effectiveAction: "escalate_to_llm",
      executed: true,
      escalation: { model: "claude-haiku-4-5", value: "technical", status: "ok", costUsd: 0.00031 },
    });
    expect(result.cost.llmCallsMade).toBe(1);
    expect(result.cost.escalationCostUsd).toBe(0.00031);
    expect(result.overallAction).toBe("escalate_to_llm");
    expect(port.requests[0]).toMatchObject({ model: "claude-haiku-4-5", maxOutputTokens: 16 });
  });

  it.each([
    ["an invalid reply", llm("maybe"), 1],
    ["a transport failure", llm(transportError("llm_unavailable")), 1],
    ["a thrown non-transport error", llm(new Error("x")), 1],
  ])("%s fails the escalation into review", async (_name, port, calls) => {
    const h = makePorts({ transport: answer, llm: port });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(escalating()), h.ports, control());
    expect(result.decisions["team"]).toMatchObject({ effectiveAction: "review", executed: true, escalation: { status: "failed" } });
    expect(result.warnings).toContain("escalation_failed");
    expect(result.overallAction).toBe("review");
    expect(result.cost.llmCallsMade).toBe(calls);
    expect(result.reviewItemIds).toHaveLength(1);
  });

  it("no LLM port fails the escalation without a call", async () => {
    const h = makePorts({ transport: answer });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(escalating()), h.ports, control());
    expect(result.decisions["team"]?.escalation).toMatchObject({ status: "failed", error: "llm_unavailable", model: "claude-haiku-4-5" });
    expect(result.cost.llmCallsMade).toBe(0);
  });

  it("an unpriced LLM model warns and books 0", async () => {
    const h = makePorts({ transport: answer, llm: llm("billing"), prices: createMemoryPriceBook([...SEED_COMPARATOR_PRICES.filter((p) => p.model !== "claude-haiku-4-5"), { model: "jev-1.13.0", inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 }]) });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(escalating()), h.ports, control());
    expect(result.warnings).toEqual(expect.arrayContaining(["escalation_unpriced", "comparator_unpriced"]));
    expect(result.cost.escalationCostUsd).toBe(0);
  });

  it("escalation_avoided savings: a run that escalated avoided nothing", async () => {
    const spec = { ...escalating(), savings: { kind: "escalation_avoided" as const } };
    const h = makePorts({ transport: answer, llm: llm("billing") });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(spec, { settings: { avgEscalationCostMicroUsd: 400 } }), h.ports, control());
    expect(result.cost.llmCallsAvoided).toBe(0);
    expect(result.cost.savingsKind).toBe("escalation_avoided");
  });
});

describe("set fallbacks and actions", () => {
  const fallbackSpec = (): QuestionSetSpec => {
    const spec = structuredClone(twoStage);
    spec.stages = [spec.stages[0]!];
    spec.policies = {
      team: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.5, medium: 0.3 },
        actions: {
          high: { kind: "fallback", config: { kind: "set", setRef: "team-router-v2" } },
          medium: { kind: "review" },
          low: { kind: "review" },
        },
      },
    };
    return spec;
  };
  const answer = () => scriptedTransport(() => ({ model: "jev-1.13.0", answers: { team: teamAnswer("billing") }, usage: { input_tokens: 10, output_tokens: 1 } }) as SystemOneResponse);

  it("runs the linked set on the original state and records fallbackRunId", async () => {
    let seen: unknown[] = [];
    const h = makePorts({
      transport: answer(),
      linkedRun: async (setRef, state, opts) => {
        seen = [setRef, state, opts.channel, opts.parentRunId];
        return { runId: "01890000-0000-7000-8000-0000000000f1", status: "ok" } as never;
      },
    });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(fallbackSpec()), h.ports, control());
    expect(seen).toEqual(["team-router-v2", { ticket: "x" }, "production", result.runId]);
    expect(result.decisions["team"]).toMatchObject({ value: "billing", fallbackRunId: "01890000-0000-7000-8000-0000000000f1", executed: true });
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["no port", undefined, false],
    ["a failed linked run", async () => ({ runId: "01890000-0000-7000-8000-0000000000f2", status: "error" }) as never, true],
    [
      "a throwing linked run",
      async () => {
        throw new Error("x");
      },
      false,
    ],
  ] as Array<[string, RunPorts["linkedRun"], boolean]>)("%s gives fallback_set_failed", async (_n, linkedRun, hasId) => {
    const h = makePorts(linkedRun === undefined ? { transport: answer() } : { transport: answer(), linkedRun });
    const result = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(fallbackSpec(), { channel: "pinned" }, ), h.ports, control());
    expect(result.warnings).toContain("fallback_set_failed");
    expect(result.decisions["team"]?.fallbackRunId !== undefined).toBe(hasId);
  });

  it("enqueues enabled handlers after persisting and warns on disabled ones", async () => {
    const spec = structuredClone(twoStage);
    spec.stages = [spec.stages[0]!];
    spec.policies = {
      team: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.5, medium: 0.3 },
        actions: { high: { kind: "auto", handler: "builtin.slack.notify", config: { channel: "#ops" } }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    };
    const enabled = makePorts({ transport: answer(), enabledHandlers: ["builtin.slack.notify"] });
    const r1 = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(spec), enabled.ports, control());
    expect(enabled.actions.jobs).toEqual([{ runId: r1.runId, decisionId: "team", handlerId: "builtin.slack.notify", config: { channel: "#ops" } }]);
    const disabled = makePorts({ transport: answer() });
    const r2 = await runQuestionSet(ctx, runRequest({ ticket: "x" }), resolvedRun(spec), disabled.ports, control());
    expect(disabled.actions.jobs).toEqual([]);
    expect(r2.warnings).toContain("action_handler_disabled");
  });
});

describe("other run details", () => {
  it("context_pruned savings read the caller's token counts", async () => {
    const spec = { ...exampleSpec(), savings: { kind: "context_pruned" as const } };
    const result = await runQuestionSet(
      ctx,
      runRequest(exampleState(), { options: { metadata: { tokensBefore: 5_000, tokensAfter: 1_000 } } }),
      resolvedRun(spec),
      makePorts().ports,
      control(),
    );
    expect(result.cost.contextTokensPruned).toBe(4_000);
    expect(result.cost.savingsUsd).toBe(0.004 - 0.000013);
  });

  it("an input adapter is not applied yet and says so", async () => {
    const spec = { ...exampleSpec(), input: { ...exampleSpec().input, adapter: { id: "builtin.email", config: {} } } };
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(spec), makePorts().ports, control());
    expect(result.warnings).toContain("input_adapter_not_applied");
  });

  it("an unknown answer type from the transport never throws", async () => {
    const transport = scriptedTransport((req) => ({
      model: "jev-1.13.0",
      answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "ranking", order: [1] }])),
      usage: { input_tokens: 10, output_tokens: 1 },
    }) as SystemOneResponse);
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), makePorts({ transport }).ports, control());
    expect(result.status).toBe("ok");
    expect(result.warnings).toContain("unknown_answer_type");
    expect(result.answers["category"]).toEqual({ type: "ranking", order: [1] });
    expect(result.runBand).toBe("low");
    expect(result.overallAction).toBe("fallback");
  });

  it("an answer for a question the batch did not ask is ignored", async () => {
    const transport = scriptedTransport(() => ({ model: "jev-1.13.0", answers: { ...EXAMPLE_ANSWERS, stray: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }) as SystemOneResponse);
    const result = await runQuestionSet(ctx, runRequest(exampleState()), resolvedRun(exampleSpec()), makePorts({ transport }).ports, control());
    expect(result.answers["stray"]).toBeUndefined();
  });

  it("uses the seed OpenRouter and Vercel routes", () => {
    expect(SEED_MODEL_ROUTES.map((r) => r.providerModelId)).toEqual(["typesafe/jev-1.13", "~typesafe/jev-latest", "typesafe-ai/jev"]);
  });
});
