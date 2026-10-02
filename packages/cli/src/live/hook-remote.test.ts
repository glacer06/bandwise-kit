import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { type Receipt, fnv1a64, readReceipts } from "../receipts/index.js";

const SETS = fileURLToPath(new URL("../../../../.bandwise/sets/", import.meta.url));
// Built from parts so the kit export scanner does not read it as a real token.
const TOKEN = ["sa", "live", "0123456789abcdef0123456789abcdef", "hookSecretValue"].join("_");
const ENV = { BANDWISE_TOKEN: TOKEN };
const PROMPT = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Rename getUser to fetchUser everywhere. apiKey=abc123" });

/** A RunResult as the hosted endpoint returns it, with only the fields the hook reads filled in. */
function runResult(o: { rollout: string; route: string | null; overallAction?: string; status?: string }): Record<string, unknown> {
  return {
    runId: "0193a000-0000-7000-8000-0000000000r1",
    setId: "0193a000-0000-7000-8000-0000000000s1",
    version: 7,
    versionId: "0193a000-0000-7000-8000-0000000000v7",
    channel: "production",
    rollout: o.rollout,
    status: o.status ?? "ok",
    modelRequested: "jev-1.13.0",
    modelResolved: "jev-1.13.0",
    runBand: "high",
    overallAction: o.overallAction ?? "auto",
    route: o.route,
    decisions: { difficulty: { value: 0, band: "high", action: "auto", effectiveAction: "auto", relevant: true } },
    cost: { systemOneCostUsd: 0.0001, counterfactualLlmCostUsd: 0.002, comparatorModel: "claude-haiku-4-5", savingsUsd: 0.0019, savingsSuppressed: null, latencyMs: 210 },
    warnings: [],
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { state: Record<string, unknown> };
}

function hostedFetch(reply: { status: number; body: unknown } | "hang" | "throw"): { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) as Sent["body"] });
    if (reply === "throw") throw new TypeError(`fetch failed ${TOKEN}`);
    if (reply === "hang") {
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, sent };
}

const receiptsFile = (): string => join(mkdtempSync(join(tmpdir(), "bandwise-hook-remote-")), "r.jsonl");

async function hook(args: string[], fetch: ReturnType<typeof hostedFetch>["fetch"], env: Record<string, string> = ENV, stdin = PROMPT) {
  const receipts = receiptsFile();
  const out = await main(["hook", "UserPromptSubmit", "--set", join(SETS, "model-tier.json"), "--receipts", receipts, ...args], { env, fetch, stdin: async () => stdin, loadLive: async () => {
    throw new Error("hosted mode must not load live mode");
  } });
  const raw = (() => {
    try {
      return readFileSync(receipts, "utf8");
    } catch {
      return "";
    }
  })();
  return { out, receipts: readReceipts(receipts).receipts, raw };
}

describe("bandwise hook with BANDWISE_TOKEN", () => {
  it("calls the hosted run endpoint with the shaped state and no provider key", async () => {
    const api = hostedFetch({ status: 200, body: runResult({ rollout: "shadow", route: "mechanical" }) });
    const { out, receipts } = await hook([], api.fetch);
    expect(out).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.url).toBe("https://app.bandwise.dev/api/v1/sets/model-tier/run");
    expect(api.sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    // Only fields the local spec names leave the machine, redacted like live mode.
    expect(api.sent[0]?.body).toEqual({ state: { prompt: "Rename getUser to fetchUser everywhere. apiKey=[redacted]" } });
    const r = receipts[0] as Receipt;
    expect(r).toMatchObject({ set: "model-tier", source: "UserPromptSubmit", provider: "bandwise", rollout: "shadow", status: "ok", acted: false, savingsUsd: 0.0019 });
    expect(r.remote).toEqual({ host: "app.bandwise.dev", version: 7, channel: "production", runId: "0193a000-0000-7000-8000-0000000000r1" });
    expect(r.specHash).toBe(fnv1a64(JSON.stringify(JSON.parse(readFileSync(join(SETS, "model-tier.json"), "utf8")))));
  });

  it("acts when the server's rollout lets it, whatever --rollout says", async () => {
    const api = hostedFetch({ status: 200, body: runResult({ rollout: "controlled", route: "mechanical" }) });
    const { out, receipts } = await hook(["--rollout", "shadow", "--remote-set", "tier"], api.fetch);
    expect(JSON.parse(out.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
    expect(api.sent[0]?.url).toBe("https://app.bandwise.dev/api/v1/sets/tier/run");
    expect(receipts[0]).toMatchObject({ set: "tier", acted: true, rollout: "controlled" });
  });

  it("never acts on a paused set", async () => {
    const api = hostedFetch({ status: 200, body: runResult({ rollout: "paused", route: "mechanical" }) });
    expect((await hook([], api.fetch)).out.stdout).toBe("");
  });

  it("fails open on an error answer and records the code", async () => {
    const api = hostedFetch({ status: 401, body: { error: { code: "unauthenticated", message: "Invalid token.", requestId: "r", retryable: false } } });
    const { out, receipts, raw } = await hook([], api.fetch);
    expect(out).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(receipts[0]).toMatchObject({ status: "unauthenticated", provider: "bandwise", acted: false, remote: { host: "app.bandwise.dev", version: null, runId: null } });
    expect(raw).not.toContain(TOKEN);
  });

  it("fails open on the server's rate limit and spend cap, and records each refusal code", async () => {
    const refusals = [
      { status: 429, code: "rate_limited", retryable: true },
      { status: 402, code: "token_budget_exceeded", retryable: false },
    ];
    for (const r of refusals) {
      const api = hostedFetch({ status: r.status, body: { error: { code: r.code, message: "Refused.", requestId: "r", retryable: r.retryable, runId: "0193a000-0000-7000-8000-0000000000r9" } } });
      const { out, receipts, raw } = await hook([], api.fetch);
      expect(api.sent).toHaveLength(1);
      expect(out).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ status: r.code, provider: "bandwise", acted: false });
      expect(raw).not.toContain(TOKEN);
    }
  });

  it("fails open on a network error, a bad body and a timeout", async () => {
    const thrown = await hook([], hostedFetch("throw").fetch);
    expect(thrown.out.stdout).toBe("");
    expect(thrown.receipts[0]?.status).toBe("network_error");
    expect(thrown.raw).not.toContain(TOKEN);

    const bad = await hook([], hostedFetch({ status: 200, body: { hello: "world" } }).fetch);
    expect(bad.receipts[0]?.status).toBe("bad_response");

    const slow = await hook(["--timeout-ms", "100"], hostedFetch("hang").fetch);
    expect(slow.out).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(slow.receipts.map((r) => r.status)).toEqual(["timeout"]);
  });

  it("stays silent with a token but a base URL it will not send the token to", async () => {
    const api = hostedFetch({ status: 200, body: runResult({ rollout: "full", route: "mechanical" }) });
    const { out, receipts } = await hook([], api.fetch, { ...ENV, BANDWISE_BASE_URL: "http://app.bandwise.dev" });
    expect(out.stdout).toBe("");
    expect(api.sent).toHaveLength(0);
    expect(receipts).toHaveLength(0);
  });

  it("skips prompts it would not send, like live mode", async () => {
    const api = hostedFetch({ status: 200, body: runResult({ rollout: "full", route: "mechanical" }) });
    const { out } = await hook([], api.fetch, ENV, JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "   " }));
    expect(out.stdout).toBe("");
    expect(api.sent).toHaveLength(0);
  });

  it("uses a local base URL for development", async () => {
    const spec = join(mkdtempSync(join(tmpdir(), "bandwise-hook-remote-")), "my-set.json");
    writeFileSync(spec, readFileSync(join(SETS, "model-tier.json"), "utf8"));
    const api = hostedFetch({ status: 200, body: runResult({ rollout: "shadow", route: null }) });
    await main(["hook", "UserPromptSubmit", "--set", spec, "--receipts", receiptsFile()], { env: { ...ENV, BANDWISE_BASE_URL: "http://[::1]:3000" }, fetch: api.fetch, stdin: async () => PROMPT });
    expect(api.sent[0]?.url).toBe("http://[::1]:3000/api/v1/sets/my-set/run");
  });
});
