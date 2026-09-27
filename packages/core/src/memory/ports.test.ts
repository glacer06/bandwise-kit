import { describe, expect, it } from "vitest";
import { EffectiveModel, isTransportError } from "../contracts/ports.js";
import { SEED_MODEL_PROFILES, SEED_MODEL_ROUTES } from "../models/catalog.js";
import { userCtx } from "../test/harness.js";
import {
  allowAllLimiter,
  allowAllQuota,
  createMemoryActionRegistry,
  createMemoryModelCatalog,
  createMemoryPriceBook,
  sequentialIds,
  staticKeyResolver,
  steppingClock,
} from "./ports.js";

describe("createMemoryModelCatalog", () => {
  const catalog = createMemoryModelCatalog(SEED_MODEL_PROFILES, SEED_MODEL_ROUTES);

  it("a versioned id on TypeSafe is pinned and sent as is", async () => {
    const e = await catalog.effective("jev-1.13.0", "typesafe");
    EffectiveModel.parse(e);
    expect(e).toMatchObject({ pinned: true, resolvedId: "jev-1.13.0", providerModelId: "jev-1.13.0", limits: { requestTokens: 64_000 } });
  });

  it("an alias uses its observed target's profile and stays moving", async () => {
    const e = await catalog.effective("jev-latest", "typesafe");
    expect(e.profile?.id).toBe("jev-1.13.0");
    expect(e).toMatchObject({ pinned: false, resolvedId: "jev-1.13.0", providerModelId: "jev-latest" });
  });

  it("OpenRouter sends the route id with tightened limits and is not pinned", async () => {
    const e = await catalog.effective("jev-1.13.0", "openrouter");
    expect(e).toMatchObject({ pinned: false, providerModelId: "typesafe/jev-1.13", limits: { requestTokens: 32_000, statePlusLongestQuestionTokens: 32_000 } });
    const alias = await catalog.effective("jev-latest", "openrouter");
    expect(alias.providerModelId).toBe("~typesafe/jev-latest");
  });

  it("no route or no row means no model id", async () => {
    expect(await catalog.effective("jev-preview", "openrouter")).toMatchObject({ providerModelId: null, limits: null });
    expect(await catalog.effective("foo-2.0.0", "typesafe")).toMatchObject({ profile: null, providerModelId: null });
    expect(await catalog.get("jev-latest")).toMatchObject({ kind: "alias" });
    expect(await catalog.routes("typesafe")).toEqual([]);
    expect(await catalog.routes("openrouter")).toHaveLength(2);
  });

  it("an alias with no observed target falls back to its own row", async () => {
    const jev = SEED_MODEL_PROFILES[1];
    if (jev === undefined) throw new Error("no seed");
    const c = createMemoryModelCatalog([{ ...jev, aliasTarget: null }]);
    expect(await c.effective("jev-latest", "typesafe")).toMatchObject({ resolvedId: null, profile: { id: "jev-latest" } });
    const dangling = createMemoryModelCatalog([{ ...jev, aliasTarget: "gone-1.0.0" }]);
    expect((await dangling.effective("jev-latest", "typesafe")).profile?.id).toBe("jev-latest");
  });
});

describe("createMemoryPriceBook", () => {
  const book = createMemoryPriceBook([
    { model: "m", inputPerMtokMicroUsd: 1, outputPerMtokMicroUsd: 0 },
    { model: "m", provider: "openrouter", inputPerMtokMicroUsd: 2, outputPerMtokMicroUsd: 0 },
    { model: "m", orgId: "org-a", inputPerMtokMicroUsd: 3, outputPerMtokMicroUsd: 0 },
    { model: "m", orgId: "org-b", inputPerMtokMicroUsd: 4, outputPerMtokMicroUsd: 0 },
  ]);
  it("org rows first, then platform rows; a provider row beats a provider-independent one", async () => {
    expect((await book.get("org-a", "m"))?.inputPerMtokMicroUsd).toBe(3);
    expect((await book.get("org-c", "m"))?.inputPerMtokMicroUsd).toBe(1);
    expect((await book.get("org-c", "m", "openrouter"))?.inputPerMtokMicroUsd).toBe(2);
    expect((await book.get("org-c", "m", "typesafe"))?.inputPerMtokMicroUsd).toBe(1);
    expect(await book.get("org-a", "unknown")).toBeNull();
  });
});

describe("small ports", () => {
  it("allow-all limiter and quota, actions, keys, clock and ids", async () => {
    const ctx = userCtx();
    expect(await allowAllLimiter(ctx, "m", 1, "run")).toEqual({ ok: true });
    expect(await allowAllQuota(ctx, "m", 1)).toEqual({ ok: true });
    const actions = createMemoryActionRegistry(["a.b"]);
    expect(await actions.isEnabled("o", "a.b")).toBe(true);
    expect(await actions.isEnabled("o", "c.d")).toBe(false);
    const keys = staticKeyResolver({ typesafe: "k" }, "platform");
    expect(await keys(ctx, "typesafe")).toEqual({ apiKey: "k", mode: "platform", provider: "typesafe" });
    await expect(keys(ctx, "openrouter")).rejects.toSatisfy(isTransportError);
    const clock = steppingClock(100, 10);
    expect([clock(), clock()]).toEqual([100, 110]);
    const ids = sequentialIds();
    expect([ids(), ids()]).toEqual(["00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002"]);
  });
});
