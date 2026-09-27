import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type SystemOneCallOptions, type SystemOneRequest, TransportError, isTransportError } from "@bandwise/core";
import { APIConnectionError, TypeSafeError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { SDK_LOG_LEVEL, SdkTransport, createSdkClient, mapSdkError } from "./sdk-transport.js";

const request: SystemOneRequest = {
  state: { ticket: "Charged twice" },
  model: "jev-1.13.0",
  questions: { is_urgent: { type: "noul", instructions: "Does `ticket` convey urgency?" } },
};

const neverAborted = new AbortController().signal;
const opts = (over: Partial<SystemOneCallOptions> = {}): SystemOneCallOptions => ({
  provider: "typesafe",
  apiKey: "ts_key_1",
  signal: neverAborted,
  timeoutMs: 1_000,
  retry: { maxRetries: 0, maxRetryAfterMs: 0 },
  ...over,
});

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}, seen: Seen[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const h = new Headers(init?.headers);
    seen.push({ url, headers: Object.fromEntries(h.entries()), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
}

const okBody = { model: "jev-1.13.0", answers: { is_urgent: { type: "noul", noul: 0.96 } }, usage: { input_tokens: 84, output_tokens: 3 } };

describe("SdkTransport success path", () => {
  it("sends to TypeSafe's base URL with the org key and returns the parsed response and request id", async () => {
    const seen: Seen[] = [];
    const t = new SdkTransport({ fetch: fakeFetch(200, okBody, { "x-typesafe-request-id": "req_abc" }, seen) });
    const out = await t.call(request, opts());
    expect(out).toEqual({ response: okBody, requestId: "req_abc" });
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer ts_key_1");
    expect(seen[0]?.body).toEqual(request);
  });

  it("sends to OpenRouter's base URL and takes the request id from the response id", async () => {
    const seen: Seen[] = [];
    const body = { ...okBody, id: "gen-dec-1", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", usage: { ...okBody.usage, cost: 0.00002 } };
    const t = new SdkTransport({ fetch: fakeFetch(200, body, {}, seen) });
    const out = await t.call({ ...request, model: "typesafe/jev-1.13" }, opts({ provider: "openrouter", apiKey: "or_key" }));
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(out.requestId).toBe("gen-dec-1");
    expect(out.response.usage.cost).toBe(0.00002);
  });

  it("sends to Vercel AI Gateway's base URL with no providerOptions, and keeps provider_metadata", async () => {
    const seen: Seen[] = [];
    const body = { ...okBody, model: "typesafe-ai/jev", provider_metadata: { gateway: { cost: "0.00001155" } } };
    const t = new SdkTransport({ fetch: fakeFetch(200, body, {}, seen) });
    const out = await t.call({ ...request, model: "typesafe-ai/jev" }, opts({ provider: "vercel", apiKey: "vck_key" }));
    expect(seen[0]?.url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer vck_key");
    expect(Object.keys(seen[0]?.body as object).sort()).toEqual(["model", "questions", "state"]);
    expect(out.response.provider_metadata?.gateway?.cost).toBe("0.00001155");
  });

  it("rejects an evaluation fallback by its header as system_one_invalid_response", async () => {
    const choice = { type: "choice", choice: "billing", confidence: 0.4, probabilities: { billing: 0.4, technical: 0.6 } };
    const body = { ...okBody, model: "typesafe-ai/jev", answers: { is_urgent: choice } };
    const t = new SdkTransport({ fetch: fakeFetch(200, body, { "x-ai-gateway-evaluation-fallback-triggered": "true" }) });
    const err = await t.call(request, opts({ provider: "vercel" })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "system_one_invalid_response", retryable: false });
  });

  it.each([
    ["choice", { type: "choice", choice: "billing", confidence: 0, probabilities: {} }],
    ["score", { type: "score", score: 1, legend: { "0": "a", "1": "b" }, confidence: 0, probabilities: {} }],
  ])("rejects a %s answer with confidence 0 and no probabilities, even without the header", async (_type, answer) => {
    const body = { ...okBody, model: "anthropic/claude-sonnet-4.5", answers: { is_urgent: answer } };
    const t = new SdkTransport({ fetch: fakeFetch(200, body) });
    const err = await t.call(request, opts({ provider: "vercel" })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "system_one_invalid_response" });
  });

  it("accepts a choice answer with confidence 0 when probabilities are present", async () => {
    const answer = { type: "choice", choice: "billing", confidence: 0, probabilities: { billing: 0.5, technical: 0.5 } };
    const t = new SdkTransport({ fetch: fakeFetch(200, { ...okBody, answers: { is_urgent: answer } }) });
    expect((await t.call(request, opts())).response.answers["is_urgent"]).toMatchObject({ confidence: 0 });
  });

  it("returns null when neither a header nor an id is present", async () => {
    const t = new SdkTransport({ fetch: fakeFetch(200, okBody) });
    expect((await t.call(request, opts())).requestId).toBeNull();
  });

  it("keeps new fields (passthrough) and rejects a response it cannot read", async () => {
    const extra = new SdkTransport({ fetch: fakeFetch(200, { ...okBody, trace: { x: 1 } }) });
    expect((await extra.call(request, opts())).response).toMatchObject({ trace: { x: 1 } });
    const bad = new SdkTransport({ fetch: fakeFetch(200, { model: "jev-1.13.0" }, { "x-typesafe-request-id": "req_bad" }) });
    const err = await bad.call(request, opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "system_one_unavailable", requestId: "req_bad" });
  });

  it("ignores TYPESAFE_BASE_URL: the base URL always comes from core", async () => {
    const before = process.env["TYPESAFE_BASE_URL"];
    process.env["TYPESAFE_BASE_URL"] = "https://evil.example.com";
    try {
      const seen: Seen[] = [];
      await new SdkTransport({ fetch: fakeFetch(200, okBody, {}, seen) }).call(request, opts());
      expect(seen[0]?.url.startsWith("https://api.typesafe.ai/")).toBe(true);
    } finally {
      if (before === undefined) delete process.env["TYPESAFE_BASE_URL"];
      else process.env["TYPESAFE_BASE_URL"] = before;
    }
  });

  it("caches one client per provider and key fingerprint", async () => {
    const t = new SdkTransport({ fetch: fakeFetch(200, okBody) });
    await t.call(request, opts());
    await t.call(request, opts());
    await t.call(request, opts({ apiKey: "ts_key_2" }));
    await t.call(request, opts({ provider: "openrouter" }));
    expect(t.cachedClients).toBe(3);
    t.evict("typesafe", "ts_key_1");
    expect(t.cachedClients).toBe(2);
  });
});

describe("SDK client construction", () => {
  it("sets baseURL, defaultModel and logLevel warn explicitly, even when TYPESAFE_LOG_LEVEL says debug", () => {
    const before = process.env["TYPESAFE_LOG_LEVEL"];
    process.env["TYPESAFE_LOG_LEVEL"] = "debug";
    try {
      const client = createSdkClient("openrouter", "or_key", "typesafe/jev-1.13");
      expect(client.logLevel).toBe(SDK_LOG_LEVEL);
      expect(client.baseURL).toBe("https://openrouter.ai/api");
      expect(client.defaultModel).toBe("typesafe/jev-1.13");
    } finally {
      if (before === undefined) delete process.env["TYPESAFE_LOG_LEVEL"];
      else process.env["TYPESAFE_LOG_LEVEL"] = before;
    }
  });

  it("builds TypeSafeClient in exactly one place, always with logLevel", () => {
    const dir = fileURLToPath(new URL("./", import.meta.url));
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const sites = sources.flatMap((f) => {
      const text = readFileSync(`${dir}${f}`, "utf8");
      return text.includes("new TypeSafeClient(") ? [{ f, text }] : [];
    });
    expect(sites.map((s) => s.f)).toEqual(["sdk-transport.ts"]);
    expect(sites[0]?.text).toMatch(/logLevel: SDK_LOG_LEVEL/);
    expect(sites[0]?.text).toMatch(/baseURL: SYSTEM_ONE_PROVIDER_BASE_URLS\[provider\]/);
    expect(sites[0]?.text).not.toMatch(/dangerouslyAllowBrowser: true/);
  });
});

// Every row of the errors table, with a synthetic response.
const statusRows: Array<[status: number, code: string, retryable: boolean]> = [
  [400, "system_one_invalid_request", false],
  [401, "system_one_auth", false],
  [402, "system_one_auth", false],
  [403, "system_one_forbidden", false],
  [404, "model_unavailable", false],
  [408, "system_one_unavailable", true],
  [413, "system_one_invalid_request", false],
  [418, "system_one_invalid_request", false],
  [422, "system_one_invalid_request", false],
  [429, "system_one_rate_limited", true],
  [500, "system_one_unavailable", true],
  [502, "system_one_unavailable", true],
  [503, "system_one_unavailable", true],
  [524, "system_one_unavailable", true],
  [529, "system_one_overloaded", true],
];

describe("error mapping", () => {
  it.each(statusRows)("HTTP %i maps to %s (retryable %s), with the request id and no provider message", async (status, code, retryable) => {
    const body = status === 402 ? { error: { code: 402, message: "secret provider detail" } } : { detail: "secret provider detail" };
    const t = new SdkTransport({ fetch: fakeFetch(status, body, { "x-typesafe-request-id": `req_${status}` }) });
    const err = await t.call(request, opts()).catch((e: unknown) => e);
    expect(isTransportError(err)).toBe(true);
    expect(err).toMatchObject({ code, retryable, requestId: `req_${status}` });
    expect((err as Error).message).not.toContain("secret provider detail");
  });

  it("a connection error is system_one_unavailable", async () => {
    const t = new SdkTransport({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await t.call(request, opts()).catch((e: unknown) => e)).toMatchObject({ code: "system_one_unavailable", requestId: null });
  });

  it("a timeout (APITimeoutError) is system_one_unavailable", async () => {
    const hang = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const t = new SdkTransport({ fetch: hang });
    expect(await t.call(request, opts({ timeoutMs: 20 })).catch((e: unknown) => e)).toMatchObject({ code: "system_one_unavailable" });
  });

  it("a caller abort (APIUserAbortError) is client_aborted", async () => {
    const controller = new AbortController();
    const hang = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const t = new SdkTransport({ fetch: hang });
    const pending = t.call(request, opts({ signal: controller.signal, timeoutMs: 5_000 })).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toMatchObject({ code: "client_aborted" });
  });

  it("an SDK validation error before sending is system_one_invalid_request", async () => {
    const t = new SdkTransport({ fetch: fakeFetch(200, okBody) });
    const err = await t.call({ ...request, questions: {} }, opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "system_one_invalid_request" });
  });

  it("mapSdkError passes TransportErrors through and maps the rest", () => {
    const te = new TransportError({ code: "system_one_auth", retryable: false, requestId: "r" }, "x");
    expect(mapSdkError(te, "typesafe")).toBe(te);
    expect(mapSdkError(new APIConnectionError("down"), "typesafe").code).toBe("system_one_unavailable");
    expect(mapSdkError(new TypeSafeError("bad"), "typesafe").code).toBe("system_one_invalid_request");
    expect(mapSdkError(new Error("other"), "openrouter").code).toBe("system_one_unavailable");
  });

  it("retries 429 inside the SDK within the budget, not in a second loop", async () => {
    let calls = 0;
    const flaky = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ detail: "slow down" }), { status: 429, headers: { "retry-after-ms": "1" } });
      return new Response(JSON.stringify(okBody), { status: 200, headers: { "content-type": "application/json" } });
    };
    const t = new SdkTransport({ fetch: flaky });
    const out = await t.call(request, opts({ retry: { maxRetries: 1, maxRetryAfterMs: 50 } }));
    expect(out.response.model).toBe("jev-1.13.0");
    expect(calls).toBe(2);
  });
});
