import { isTransportError } from "@bandwise/core";
import { describe, expect, it } from "vitest";
import { ClientCache, keyFingerprint } from "./client-cache.js";
import { FixtureTransport } from "./fixture/fixture-transport.js";
import { createScrubbingLogger, scrub } from "./logger.js";
import { aliasProbeRequest, listModels, openRouterSystemOneModelIds, probeAlias } from "./models.js";

describe("scrubbing logger", () => {
  it("redacts tokens, bearer headers and long keys; drops structured values", () => {
    const text = "auth Bearer abc.def sk_live_123abc sa_live_xyz pk_live_q sk-or-v1-abcdef " + "k".repeat(40) + " ok";
    expect(scrub(text)).toBe("auth [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] ok");
    const lines: string[] = [];
    const logger = createScrubbingLogger({ warn: (l) => lines.push(`W ${l}`), error: (l) => lines.push(`E ${l}`) });
    logger.debug("body", { state: "secret" });
    logger.info("request", { state: "secret" });
    logger.warn("retrying with sk_test_abc", { body: { state: "secret" } }, 2);
    logger.error("failed");
    expect(lines).toEqual(["W [system-one] retrying with [redacted] (2 values dropped)", "E [system-one] failed"]);
    expect(lines.join(" ")).not.toContain("secret");
  });

  it("defaults to the console", () => {
    const logger = createScrubbingLogger();
    const warn = console.warn;
    const error = console.error;
    const seen: string[] = [];
    console.warn = (l: string) => seen.push(l);
    console.error = (l: string) => seen.push(l);
    try {
      logger.warn("w");
      logger.error("e");
    } finally {
      console.warn = warn;
      console.error = error;
    }
    expect(seen).toEqual(["[system-one] w", "[system-one] e"]);
  });
});

describe("ClientCache", () => {
  it("keys by provider and fingerprint and evicts the least recently used", () => {
    expect(keyFingerprint("abc")).toBe("ba7816bf8f01cfea");
    const cache = new ClientCache<number>(2);
    let made = 0;
    const make = () => ++made;
    expect(cache.getOrCreate("typesafe", "a", make)).toBe(1);
    expect(cache.getOrCreate("typesafe", "a", make)).toBe(1);
    expect(cache.getOrCreate("openrouter", "a", make)).toBe(2);
    cache.getOrCreate("typesafe", "a", make); // touch: typesafe:a is now newest
    expect(cache.getOrCreate("typesafe", "b", make)).toBe(3); // evicts openrouter:a
    expect(cache.size).toBe(2);
    expect(cache.getOrCreate("openrouter", "a", make)).toBe(4);
  });
});

describe("model helpers", () => {
  it("listModels reads GET /v1/models on TypeSafe", async () => {
    const fetch = async (url: string) => {
      expect(url).toBe("https://api.typesafe.ai/v1/models");
      return new Response(JSON.stringify({ models: [{ name: "jev-latest", description: "Latest", release_date: "2026-09-17", extra: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    expect(await listModels("typesafe", "k", { fetch, timeoutMs: 1_000, signal: new AbortController().signal })).toEqual([
      { name: "jev-latest", description: "Latest", release_date: "2026-09-17" },
    ]);
  });

  it("listModels reads GET /typesafe/v1/models on Vercel AI Gateway", async () => {
    const seen: string[] = [];
    const fetch = async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ models: [{ name: "typesafe-ai/jev", description: "Jev", release_date: "2026-09-17" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    expect((await listModels("vercel", "vck", { fetch })).map((c) => c.name)).toEqual(["typesafe-ai/jev"]);
    expect(seen).toEqual(["https://ai-gateway.vercel.sh/typesafe/v1/models"]);
  });

  it("listModels maps errors and refuses OpenRouter", async () => {
    const fetch = async () => new Response(JSON.stringify({ detail: "no" }), { status: 401 });
    expect(await listModels("typesafe", "k", { fetch }).catch((e: unknown) => e)).toMatchObject({ code: "system_one_auth" });
    const err = await listModels("openrouter", "k").catch((e: unknown) => e);
    expect(isTransportError(err)).toBe(true);
  });

  it("reads System One ids from OpenRouter's Models API", () => {
    const body = { data: [{ id: "typesafe/jev-1.13" }, { id: "~typesafe/jev-latest" }, { id: "anthropic/claude" }, { id: 3 }, null] };
    expect(openRouterSystemOneModelIds(body)).toEqual(["typesafe/jev-1.13", "~typesafe/jev-latest"]);
    expect(openRouterSystemOneModelIds(null)).toEqual([]);
    expect(openRouterSystemOneModelIds({ data: "x" })).toEqual([]);
  });

  it("probeAlias sends a one-noul request and reports the build that answered", async () => {
    const transport = new FixtureTransport([], { synthesize: true, resolveModel: () => "jev-1.13.0" });
    const obs = await probeAlias(transport, { alias: "jev-latest", provider: "typesafe", apiKey: "k", signal: new AbortController().signal });
    expect(obs).toEqual({ requested: "jev-latest", resolved: "jev-1.13.0", requestId: null, provider: "typesafe" });
    expect(Object.values(aliasProbeRequest("m").questions)).toHaveLength(1);
    const or = await probeAlias(transport, { alias: "jev-latest", sendAs: "~typesafe/jev-latest", provider: "openrouter", apiKey: "k", signal: new AbortController().signal, timeoutMs: 50 });
    expect(transport.calls[1]?.request.model).toBe("~typesafe/jev-latest");
    expect(or.requested).toBe("jev-latest");
  });
});
