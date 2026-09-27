import { readFileSync } from "node:fs";
import {
  type QuestionSetSpec,
  type RunPorts,
  type SystemOneCallOptions,
  type SystemOneProvider,
  RunResult,
  SEED_COMPARATOR_PRICES,
  SEED_MODEL_PROFILES,
  SEED_MODEL_ROUTES,
  SEED_SYSTEM_ONE_PRICES,
  SystemOneResponse,
  allowAllLimiter,
  allowAllQuota,
  createMemoryActionRegistry,
  createMemoryModelCatalog,
  createMemoryPriceBook,
  createMemoryRunSink,
  isTransportError,
  parseSpec,
  runQuestionSet,
  sequentialIds,
  staticKeyResolver,
  steppingClock,
} from "@bandwise/core";
import { describe, expect, it } from "vitest";
import { FixtureTransport } from "./fixture-transport.js";
import { BUNDLED_FIXTURES_DIR, loadBundledFixtures, loadFixturesFromDir } from "./load.js";
import { syntheticResponse } from "./synthetic.js";

const fixtures = loadBundledFixtures();
const signal = new AbortController().signal;
const opts = (provider: SystemOneProvider = "typesafe"): SystemOneCallOptions => ({
  provider,
  apiKey: "k",
  signal,
  timeoutMs: 1_000,
  retry: { maxRetries: 0, maxRetryAfterMs: 0 },
});
const named = (provider: string, name: string) => {
  const f = fixtures.find((x) => x.provider === provider && x.name === name);
  if (f === undefined) throw new Error(`no fixture ${provider}/${name}`);
  return f;
};

describe("FixtureTransport", () => {
  const transport = new FixtureTransport(fixtures);

  it("replays a fixture by request and provider", async () => {
    const f = named("typesafe", "choice-single");
    const out = await transport.call(f.request, opts());
    expect(out.requestId).toBe("req_fx_choice_single");
    expect(SystemOneResponse.parse(out.response).answers["department"]).toMatchObject({ choice: "billing" });
    expect(transport.has("typesafe", f.request)).toBe(true);
    expect(transport.has("openrouter", f.request)).toBe(false);
  });

  it("OpenRouter fixtures take the request id from the response id", async () => {
    const out = await transport.call(named("openrouter", "noul").request, opts("openrouter"));
    expect(out.requestId).toBe("gen-dec-fx-noul");
  });

  it.each([
    ["typesafe", "error-401", "system_one_auth", "req_fx_401"],
    ["typesafe", "error-422", "system_one_invalid_request", "req_fx_422"],
    ["typesafe", "error-429", "system_one_rate_limited", "req_fx_429"],
    ["typesafe", "error-529", "system_one_overloaded", "req_fx_529"],
    ["openrouter", "error-402", "system_one_auth", null],
    ["typesafe", "outage-503", "system_one_unavailable", "req_fx_503"],
    ["openrouter", "outage-503", "system_one_unavailable", null],
    ["vercel", "outage-503", "system_one_unavailable", null],
    ["vercel", "evaluation-fallback", "system_one_invalid_response", null],
  ] as const)("%s/%s throws %s", async (provider, name, code, requestId) => {
    const err = await transport.call(named(provider, name).request, opts(provider)).catch((e: unknown) => e);
    expect(isTransportError(err)).toBe(true);
    expect(err).toMatchObject({ code, requestId });
  });

  it("rejects an evaluation fallback by its answer shape even without the header", async () => {
    const f = named("vercel", "evaluation-fallback");
    if (!("response" in f)) throw new Error("evaluation-fallback must be a response fixture");
    const noHeader = new FixtureTransport([{ ...f, responseHeaders: {} }]);
    const err = await noHeader.call(f.request, opts("vercel")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "system_one_invalid_response", retryable: false });
  });

  it("a request no fixture covers fails unless synthesis is on", async () => {
    const req = { state: "x", model: "jev-1.13.0", questions: { q: { type: "noul" as const, instructions: "Is it?" } } };
    const err = await transport.call(req, opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "system_one_invalid_request" });
    const synth = new FixtureTransport([], { synthesize: true, resolveModel: (m) => (m === "jev-latest" ? "jev-1.13.0" : m) });
    const a = await synth.call({ ...req, model: "jev-latest" }, opts());
    const b = await synth.call({ ...req, model: "jev-latest" }, opts());
    expect(a).toEqual(b);
    expect(a.response.model).toBe("jev-1.13.0");
    expect(a.requestId).toBeNull();
    expect(synth.calls.map((c) => c.fixture)).toEqual([null, null]);
    const plain = new FixtureTransport([], { synthesize: true });
    expect((await plain.call(req, opts())).response.model).toBe("jev-1.13.0");
  });

  it("an aborted signal throws client_aborted without recording a call", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = new FixtureTransport(fixtures);
    const err = await t.call(named("typesafe", "noul-single").request, { ...opts(), signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "client_aborted" });
    expect(t.calls).toHaveLength(0);
  });

  it("loads the bundled set and rejects a bad fixture file", () => {
    expect(new FixtureTransport(fixtures).size).toBe(fixtures.length);
    expect(loadFixturesFromDir(`${BUNDLED_FIXTURES_DIR}openrouter`)).toHaveLength(6);
    expect(loadFixturesFromDir(`${BUNDLED_FIXTURES_DIR}vercel`)).toHaveLength(5);
    expect(() => loadFixturesFromDir(new URL("../../fixtures/specs/", import.meta.url).pathname)).toThrow(/invalid fixture/);
  });
});

describe("synthetic answers", () => {
  it("fit the answer schemas for every type", () => {
    const res = syntheticResponse(
      {
        state: { a: 1 },
        model: "m",
        questions: {
          n: { type: "noul", instructions: "n" },
          c: { type: "choice", instructions: "c", criteria: { a: null, b: "B", none: null } },
          s: { type: "score", instructions: "s", criteria: ["low", "mid", "high"] },
          one: { type: "choice", instructions: "c", criteria: { only: null } },
        },
      },
      "m-1",
    );
    const parsed = SystemOneResponse.parse(res);
    expect(parsed.model).toBe("m-1");
    const c = parsed.answers["c"] as { choice: string; probabilities: Record<string, number>; confidence: number };
    expect(Object.keys(c.probabilities)).toEqual(["a", "b", "none"]);
    expect(c.confidence).toBeGreaterThanOrEqual(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
    const s = parsed.answers["s"] as { score: number; legend: Record<string, string> };
    expect(s.legend).toEqual({ "0": "low", "1": "mid", "2": "high" });
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(2);
    expect(parsed.answers["one"]).toMatchObject({ choice: "only", confidence: 1 });
    expect(parsed.usage.output_tokens).toBe(8);
  });

  it("handles long questions sets by extending the hash stream", () => {
    const criteria = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, null]));
    const res = syntheticResponse({ state: "x", model: "m", questions: { c: { type: "choice", instructions: "c", criteria } } }, "m");
    expect(Object.keys((res.answers["c"] as { probabilities: object }).probabilities)).toHaveLength(40);
  });
});

// Policy replay and end-to-end runs on recorded fixtures: the engine returns a valid RunResult.
const ORG = "01890000-0000-7000-8000-00000000000a";
const ctx = {
  orgId: ORG,
  actor: { type: "user" as const, userId: "01890000-0000-7000-8000-0000000000c1", role: "owner" as const, platformRole: null, impersonatorId: null },
  client: "console" as const,
  plan: "pro",
  requestId: "r",
};

function ports(transport: FixtureTransport): RunPorts {
  return {
    systemOne: transport,
    models: createMemoryModelCatalog(SEED_MODEL_PROFILES, SEED_MODEL_ROUTES),
    keys: staticKeyResolver({ typesafe: "ts", openrouter: "or", vercel: "vg" }),
    limiter: allowAllLimiter,
    quota: allowAllQuota,
    runs: createMemoryRunSink(sequentialIds("00000000-0000-7000-9000-")),
    actions: createMemoryActionRegistry(),
    prices: createMemoryPriceBook([...SEED_SYSTEM_ONE_PRICES, ...SEED_COMPARATOR_PRICES]),
    clock: steppingClock(),
    newId: sequentialIds(),
  };
}

function resolved(spec: QuestionSetSpec, provider: SystemOneProvider = "typesafe") {
  return {
    spec,
    setId: "01890000-0000-7000-8000-0000000000a1",
    version: 1,
    versionId: "01890000-0000-7000-8000-0000000000b1",
    interfaceMajor: 1,
    interfaceHash: "h",
    channel: "production" as const,
    rollout: "full" as const,
    settings: {
      dispatchActionsOnStaging: false,
      storageMode: "full" as const,
      piiMode: "off" as const,
      defaultComparatorModel: "claude-haiku-4-5",
      avgEscalationCostMicroUsd: null,
      systemOneProvider: provider,
    },
  };
}

const refundSpec: QuestionSetSpec = {
  schemaVersion: 1,
  model: "jev-latest",
  input: { schema: { type: "object" } },
  stages: [{ id: "main", questions: { refund: { type: "noul", instructions: "Is the customer who wrote `ticket` asking for a refund?", criteria: { true: "Asks for money back", false: "No refund request" }, meta: { label: "Refund" } } } }],
  policies: { refund: { type: "noul", gating: true, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } } },
};

const twoStage = (() => {
  const parsed = parseSpec(JSON.parse(readFileSync(`${BUNDLED_FIXTURES_DIR}specs/two-stage.json`, "utf8")));
  if (!parsed.ok) throw new Error("two-stage spec");
  return parsed.spec;
})();

describe("the engine on recorded fixtures", () => {
  it("a two-stage run replays both stages and returns a valid RunResult", async () => {
    const transport = new FixtureTransport(fixtures);
    const result = await runQuestionSet(
      ctx,
      { setRef: "support", state: { ticket: "I was charged twice for my plan this month. Please refund one of the charges." }, source: "api", options: {} },
      resolved(twoStage),
      ports(transport),
      { signal, budgetMs: 8_000 },
    );
    expect(RunResult.parse(result).status).toBe("ok");
    expect(transport.calls.map((c) => c.fixture)).toEqual(["multi-stage-1", "multi-stage-2"]);
    expect(result.route).toBe("refund_queue");
    expect(result.typesafeRequestId).toBe("req_fx_multi_1");
    expect(result.cost.systemOneInputTokens).toBe(97 + 131);
  });

  it("an OpenRouter fixture run stores the OpenRouter id and prices from usage.cost", async () => {
    const spec: QuestionSetSpec = {
      schemaVersion: 1,
      model: "jev-1.13.0",
      input: { schema: { type: "object" } },
      stages: [{ id: "main", questions: { is_urgent: { type: "noul", instructions: "Does `ticket` convey urgency?", criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" }, meta: { label: "Urgent" } } } }],
      policies: { is_urgent: { type: "noul", gating: true, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } } },
    };
    const transport = new FixtureTransport(fixtures);
    const state = { ticket: { subject: "Charged twice", body: "Help! I was charged twice for my plan this month and I need a refund today." } };
    const result = await runQuestionSet(ctx, { setRef: "s", state, source: "api", options: {} }, resolved(spec, "openrouter"), ports(transport), { signal, budgetMs: 8_000 });
    expect(transport.calls[0]).toMatchObject({ fixture: "noul", provider: "openrouter" });
    expect(transport.calls[0]?.request.model).toBe("typesafe/jev-1.13");
    expect(result.modelResolved).toBe("typesafe/jev-1.13-20260917");
    expect(result.cost.systemOneCostUsd).toBe(0.000004);
    expect(result.warnings).toEqual([]);
  });

  it("a Vercel fixture run sends typesafe-ai/jev and prices from provider_metadata.gateway.cost", async () => {
    const f = named("vercel", "noul");
    const transport = new FixtureTransport(fixtures);
    const result = await runQuestionSet(ctx, { setRef: "s", state: f.request.state, source: "api", options: {} }, resolved(refundSpec, "vercel"), ports(transport), { signal, budgetMs: 8_000 });
    expect(transport.calls[0]).toMatchObject({ fixture: "noul", provider: "vercel" });
    expect(transport.calls[0]?.request.model).toBe("typesafe-ai/jev");
    expect(result.status).toBe("ok");
    expect(result.modelResolved).toBe("typesafe-ai/jev");
    expect(result.cost.systemOneCostUsd).toBe(0.000012);
    expect(result.warnings).not.toContain("model_resolved_unmapped");
  });

  it("an evaluation fallback on Vercel fails the run with system_one_invalid_response and is never banded", async () => {
    const f = named("vercel", "evaluation-fallback");
    const spec: QuestionSetSpec = {
      schemaVersion: 1,
      model: "jev-latest",
      input: { schema: { type: "object" } },
      stages: [{ id: "main", questions: { department: { type: "choice", instructions: "Which team should handle `ticket`?", criteria: { billing: "Payments, refunds", technical: "Bugs, outages", account: "Login and profile", none_of_these: null }, meta: { label: "Department" } } } }],
      policies: { department: { type: "choice", gating: true, thresholds: { high: 0.75, medium: 0.45 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } } },
    };
    const transport = new FixtureTransport(fixtures);
    const result = await runQuestionSet(ctx, { setRef: "s", state: f.request.state, source: "api", options: {} }, resolved(spec, "vercel"), ports(transport), { signal, budgetMs: 8_000 });
    expect(transport.calls[0]).toMatchObject({ fixture: "evaluation-fallback", provider: "vercel" });
    expect(result).toMatchObject({ status: "error", error: { code: "system_one_invalid_response" } });
    expect(result.decisions["department"]?.value ?? null).toBeNull();
  });

  it.each(["typesafe", "openrouter", "vercel"] as const)("an outage fixture on %s returns the set's outage rule, never an empty decision set", async (provider) => {
    const spec: QuestionSetSpec = {
      schemaVersion: 1,
      // Vercel documents only typesafe-ai/jev, which the seed routes to jev-latest.
      model: provider === "vercel" ? "jev-latest" : "jev-1.13.0",
      input: { schema: { type: "object" } },
      stages: [{ id: "main", questions: { is_urgent: { type: "noul", instructions: "Does `ticket` convey urgency?", criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" }, meta: { label: "Urgent" } } } }],
      policies: { is_urgent: { type: "noul", gating: true, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } } },
      onUnavailable: "review",
    };
    const f = named(provider, "outage-503");
    const transport = new FixtureTransport(fixtures);
    const result = await runQuestionSet(ctx, { setRef: "s", state: f.request.state, source: "api", options: {} }, resolved(spec, provider), ports(transport), { signal, budgetMs: 8_000 });
    expect(RunResult.parse(result)).toBeTruthy();
    expect(transport.calls[0]).toMatchObject({ fixture: "outage-503", provider });
    expect(result).toMatchObject({ status: "error", error: { code: "system_one_unavailable" }, runBand: "low", overallAction: "review" });
    expect(result.decisions["is_urgent"]).toMatchObject({ band: "low", value: null, effectiveAction: "review", executed: true });
    expect(result.warnings).toContain("system_one_outage");
    expect(result.cost.savingsSuppressed).toBe("outage");
  });
});
