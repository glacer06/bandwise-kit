// System One through OpenRouter and Vercel AI Gateway. Response passthrough, id mapping, routes and limits.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEED_MODEL_PROFILES, SEED_MODEL_ROUTES } from "../models/catalog.js";
import {
  ModelRoute,
  effectiveLimits,
  registryIdForResolved,
  resolveRoute,
  type ModelProfile,
} from "./models.js";
import { RunCall, reportedCostMicroUsd, responseCostMicroUsd, usdFromMicro } from "./run.js";
import {
  SYSTEM_ONE_PROVIDER_BASE_URLS,
  SystemOneProvider,
  SystemOneResponse,
  defaultProviderModelId,
  fromOpenRouterModelId,
  toOpenRouterModelId,
  toVercelModelId,
} from "./system-one.js";

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as unknown;
}

function profile(id: string): ModelProfile {
  const found = SEED_MODEL_PROFILES.find((p) => p.id === id);
  if (found === undefined) throw new Error(`missing seed row ${id}`);
  return found;
}

describe("SystemOneProvider", () => {
  it("is typesafe, openrouter or vercel, each with its SDK baseURL", () => {
    expect(SystemOneProvider.options).toEqual(["typesafe", "openrouter", "vercel"]);
    expect(SYSTEM_ONE_PROVIDER_BASE_URLS).toEqual({
      typesafe: "https://api.typesafe.ai",
      openrouter: "https://openrouter.ai/api",
      vercel: "https://ai-gateway.vercel.sh/typesafe",
    });
  });
});

describe("Vercel AI Gateway responses", () => {
  // Vercel's documented example on "TypeSafe API with AI Gateway", checked 2026-09-27.
  const body = {
    model: "typesafe-ai/jev",
    answers: { refund: { type: "noul", noul: 0.98 } },
    usage: { input_tokens: 275, output_tokens: 20 },
    provider_metadata: { gateway: { cost: "0.00001155", marketCost: "0.00001155", generationId: "gen_01" } },
  };

  it("parses the documented example and keeps every gateway field", () => {
    const parsed = SystemOneResponse.parse(body);
    expect(parsed).toEqual(body);
    expect(parsed.provider_metadata?.gateway?.cost).toBe("0.00001155");
  });

  it("takes provider_metadata.gateway.cost as the reported cost, rounded to whole micro-USD", () => {
    expect(responseCostMicroUsd(SystemOneResponse.parse(body))).toBe(12);
    expect(responseCostMicroUsd({ usage: {}, provider_metadata: { gateway: { cost: "0" } } })).toBe(0);
  });

  it("prefers usage.cost, and ignores a gateway cost that is not a plain decimal", () => {
    expect(responseCostMicroUsd({ usage: { cost: 0.00003 }, provider_metadata: { gateway: { cost: "0.001" } } })).toBe(30);
    expect(responseCostMicroUsd({ usage: {}, provider_metadata: { gateway: { cost: "-1" } } })).toBeNull();
    expect(responseCostMicroUsd({ usage: {}, provider_metadata: { gateway: { cost: "1e-5" } } })).toBeNull();
    expect(responseCostMicroUsd({ usage: {} })).toBeNull();
  });

  it("rejects a gateway cost that is not a string", () => {
    expect(SystemOneResponse.safeParse({ ...body, provider_metadata: { gateway: { cost: 0.1 } } }).success).toBe(false);
  });
});

describe("Vercel model ids", () => {
  it("maps jev-latest to the one documented id and keeps prefixed ids", () => {
    expect(toVercelModelId("jev-latest")).toBe("typesafe-ai/jev");
    expect(toVercelModelId("typesafe-ai/jev")).toBe("typesafe-ai/jev");
    expect(defaultProviderModelId("vercel", "jev-latest", "alias")).toBe("typesafe-ai/jev");
  });

  it("has one seed route: jev-latest as typesafe-ai/jev, not pinned, and no versioned route", () => {
    const vercel = SEED_MODEL_ROUTES.filter((r) => r.provider === "vercel");
    expect(vercel.map((r) => [r.modelId, r.providerModelId, r.pinned])).toEqual([["jev-latest", "typesafe-ai/jev", false]]);
    expect(resolveRoute(profile("jev-1.13.0"), "vercel", SEED_MODEL_ROUTES)).toBeNull();
    const latest = resolveRoute(profile("jev-latest"), "vercel", SEED_MODEL_ROUTES);
    expect(latest).toMatchObject({ provider: "vercel", providerModelId: "typesafe-ai/jev", pinned: false });
    expect(latest?.limits).toEqual(profile("jev-latest").limits);
    expect(registryIdForResolved("vercel", "typesafe-ai/jev", SEED_MODEL_ROUTES)).toBe("jev-latest");
    expect(registryIdForResolved("vercel", "openai/gpt-5", SEED_MODEL_ROUTES)).toBeNull();
  });
});

describe("OpenRouter responses", () => {
  it("parses the documented API reference example and keeps id, provider and usage.cost", () => {
    const body = readJson("./__fixtures__/openrouter-systemone-response.json");
    const parsed = SystemOneResponse.parse(body);
    expect(parsed).toEqual(body);
    expect(parsed.id).toBe("gen-dec-1789738314-X5e5eKGQdvR9rblyX250");
    expect(parsed.model).toBe("typesafe/jev-1.13-20260917");
    expect(parsed.provider).toBe("TypeSafe");
    expect(parsed.usage.cost).toBe(0.000019992);
  });

  it("parses the SDK guide example", () => {
    const body = {
      id: "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers: { refund: { type: "noul", noul: 0.98 } },
      usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
    };
    expect(SystemOneResponse.parse(body)).toEqual(body);
  });

  it("still parses a TypeSafe direct response with no id, provider or cost", () => {
    const body = { model: "jev-1.13.0", answers: { refund: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 275, output_tokens: 20 } };
    const parsed = SystemOneResponse.parse(body);
    expect(parsed.usage.cost).toBeUndefined();
    expect(reportedCostMicroUsd(parsed.usage)).toBeNull();
  });

  it("rejects a negative cost", () => {
    const body = { model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0, cost: -0.1 } };
    expect(SystemOneResponse.safeParse(body).success).toBe(false);
  });

  it("turns usage.cost into whole micro-USD", () => {
    expect(reportedCostMicroUsd({ cost: 0.00003 })).toBe(30);
    expect(reportedCostMicroUsd({ cost: 0.000019992 })).toBe(20);
    expect(reportedCostMicroUsd({ cost: 0 })).toBe(0);
  });
});

describe("RunCall provider fields", () => {
  const call = { modelResolved: "typesafe/jev-1.13-20260917", typesafeRequestId: "gen-dec-1", inputTokens: 476, outputTokens: 70, latencyMs: 180 };

  it("records the provider and its reported cost in whole micro-USD", () => {
    const withCost = { ...call, provider: "openrouter", providerCostUsd: usdFromMicro(20) };
    expect(RunCall.parse(withCost)).toEqual(withCost);
    expect(RunCall.safeParse({ ...call, providerCostUsd: 0.000019992 }).success).toBe(false);
  });

  it("still parses a call recorded before provider routes existed", () => {
    expect(RunCall.parse(call)).toEqual(call);
  });
});

describe("OpenRouter model ids", () => {
  it("maps bare TypeSafe ids the way OpenRouter documents", () => {
    expect(toOpenRouterModelId("jev-1.13", null)).toBe("typesafe/jev-1.13");
    expect(toOpenRouterModelId("jev-latest", "alias")).toBe("~typesafe/jev-latest");
    expect(toOpenRouterModelId("typesafe/jev-1.13", null)).toBe("typesafe/jev-1.13");
    expect(toOpenRouterModelId("~typesafe/jev-latest", "alias")).toBe("~typesafe/jev-latest");
  });

  it("strips the OpenRouter namespace from response ids and leaves other authors alone", () => {
    expect(fromOpenRouterModelId("typesafe/jev-1.13-20260917")).toBe("jev-1.13-20260917");
    expect(fromOpenRouterModelId("~typesafe/jev-latest")).toBe("jev-latest");
    expect(fromOpenRouterModelId("jev-1.13.0")).toBe("jev-1.13.0");
    expect(fromOpenRouterModelId("openai/gpt-5")).toBe("openai/gpt-5");
  });

  it("sends TypeSafe ids unchanged on the typesafe provider", () => {
    expect(defaultProviderModelId("typesafe", "jev-latest", "alias")).toBe("jev-latest");
    expect(defaultProviderModelId("openrouter", "jev-latest", "alias")).toBe("~typesafe/jev-latest");
  });

  it("maps a response model back to a registry id through the route rows", () => {
    expect(registryIdForResolved("openrouter", "typesafe/jev-1.13-20260917", SEED_MODEL_ROUTES)).toBe("jev-1.13.0");
    expect(registryIdForResolved("openrouter", "typesafe/jev-1.13", SEED_MODEL_ROUTES)).toBe("jev-1.13.0");
    expect(registryIdForResolved("openrouter", "typesafe/jev-1.14-20261101", SEED_MODEL_ROUTES)).toBeNull();
    expect(registryIdForResolved("typesafe", "jev-1.13.0", SEED_MODEL_ROUTES)).toBe("jev-1.13.0");
  });
});

describe("ModelRoute", () => {
  const row = SEED_MODEL_ROUTES[0];

  it("parses the seed rows", () => {
    for (const r of SEED_MODEL_ROUTES) expect(ModelRoute.parse(r)).toEqual(r);
  });

  it("has no typesafe rows, since typesafe is the identity route", () => {
    expect(ModelRoute.safeParse({ ...row, provider: "typesafe" }).success).toBe(false);
  });

  it("rejects repeated resolved ids and a bad limit order", () => {
    expect(ModelRoute.safeParse({ ...row, resolvedIds: ["a", "a"] }).success).toBe(false);
    const limits = { requestTokens: 16_000, statePlusLongestQuestionTokens: 32_000, rpm: null, tokensPerSec: null };
    expect(ModelRoute.safeParse({ ...row, limits }).success).toBe(false);
  });

  it("points every seed route at a seed profile, and the ids match the provider's default mapping", () => {
    for (const r of SEED_MODEL_ROUTES) {
      const p = profile(r.modelId);
      if (r.provider === "vercel") expect(r.providerModelId).toBe(toVercelModelId(p.id));
      else if (p.kind === "alias") expect(r.providerModelId).toBe(toOpenRouterModelId(p.id, p.kind));
      else expect(r.providerModelId).toBe(toOpenRouterModelId("jev-1.13", null));
    }
  });
});

describe("provider-aware limits for preflight", () => {
  const pinned = profile("jev-1.13.0");

  it("keeps the TypeSafe limits on the identity route", () => {
    const route = resolveRoute(pinned, "typesafe", SEED_MODEL_ROUTES);
    expect(route).toEqual({ provider: "typesafe", providerModelId: "jev-1.13.0", pinned: true, limits: pinned.limits });
  });

  it("uses OpenRouter's 32k context for the whole request on the openrouter route", () => {
    const route = resolveRoute(pinned, "openrouter", SEED_MODEL_ROUTES);
    expect(route?.providerModelId).toBe("typesafe/jev-1.13");
    expect(route?.limits).toEqual({
      requestTokens: 32_000,
      statePlusLongestQuestionTokens: 32_000,
      rpm: 1_200,
      tokensPerSec: 250_000,
    });
  });

  it("is not pinned on OpenRouter until a route row says so", () => {
    expect(resolveRoute(pinned, "openrouter", SEED_MODEL_ROUTES)?.pinned).toBe(false);
    const pinnedRoutes = SEED_MODEL_ROUTES.map((r) => (r.modelId === "jev-1.13.0" ? { ...r, pinned: true } : r));
    expect(resolveRoute(pinned, "openrouter", pinnedRoutes)?.pinned).toBe(true);
    // An alias never becomes pinned through a route.
    const aliasRoutes = SEED_MODEL_ROUTES.map((r) => ({ ...r, pinned: true }));
    expect(resolveRoute(profile("jev-latest"), "openrouter", aliasRoutes)?.pinned).toBe(false);
  });

  it("returns null when the provider has no route for the model", () => {
    expect(resolveRoute(profile("jev-preview"), "openrouter", SEED_MODEL_ROUTES)).toBeNull();
  });

  it("tightens each limit and never loosens one", () => {
    const base = { requestTokens: 64_000, statePlusLongestQuestionTokens: 32_000, rpm: 1_200, tokensPerSec: 250_000 };
    expect(effectiveLimits(base, null)).toEqual(base);
    expect(effectiveLimits(null, { requestTokens: 1, statePlusLongestQuestionTokens: 1, rpm: 1, tokensPerSec: 1 })).toBeNull();
    expect(
      effectiveLimits(base, { requestTokens: 128_000, statePlusLongestQuestionTokens: null, rpm: 60, tokensPerSec: null }),
    ).toEqual({ ...base, rpm: 60 });
    expect(
      effectiveLimits(base, { requestTokens: 16_000, statePlusLongestQuestionTokens: null, rpm: null, tokensPerSec: null }),
    ).toEqual({ ...base, requestTokens: 16_000, statePlusLongestQuestionTokens: 16_000 });
  });
});
