import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunResult } from "@bandwise/core";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { readReceipts } from "../receipts/index.js";
import { fnv1a64 } from "../receipts/index.js";
import { hookResponse, isTrustedCommand, lastExchange, mapHookInput, readLaunchProfile, readProviderKey, redactSecrets, runHook, setSlug, shapeState, taskStats } from "./index.js";
import type { HookCommand } from "./hook.js";
import { liveTransport } from "./transport.js";

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const SETS = at("../../../../.bandwise/sets/");
const DEMO_SPEC = at("../../../../examples/email-triage.spec.json");
const DEMO_STATE = at("../../../../examples/email-triage.state.json");
const KEY = "ts_test_key_for_unit_tests_only_0000";
const ENV = { TYPESAFE_API_KEY: KEY };

type Answers = Record<string, unknown>;

interface Sent {
  url: string;
  auth: string | null;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown }> };
}

/** A fetch that answers like POST /v1/systemone. `pick` overrides answers per question id. */
function fakeFetch(pick: Answers = {}, opts: { delayMs?: number; status?: number } = {}): { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    try {
      return await answer(input, init);
    } catch (e) {
      sent.push({ url: `THROWN ${(e as Error).stack}`, auth: null, body: { model: "", state: {}, questions: {} } });
      throw e;
    }
  };
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Sent["body"];
    sent.push({ url, auth: headers.get("authorization"), body });
    if (opts.delayMs !== undefined) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    if (opts.status !== undefined) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: opts.status, headers: { "content-type": "application/json" } });
    const answers: Answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (pick[id] !== undefined) answers[id] = pick[id];
      else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.03 };
      else if (q.type === "choice") {
        const keys = Object.keys(q.criteria as Record<string, unknown>);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.94 : 0.06 / (keys.length - 1)]));
        answers[id] = { type: "choice", choice: keys[0], confidence: 0.9, probabilities };
      } else {
        const levels = Array.isArray(q.criteria) ? q.criteria.length : Object.keys((q.criteria ?? { a: 1, b: 2, c: 3 }) as object).length;
        const probabilities = Object.fromEntries([...Array(levels).keys()].map((i) => [String(i), i === 0 ? 0.9 : 0.1 / (levels - 1)]));
        const legend = Object.fromEntries([...Array(levels).keys()].map((i) => [String(i), `level ${i}`]));
        answers[id] = { type: "score", score: 0.1, confidence: 0.85, legend, probabilities };
      }
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 20 } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": "req_unit" },
    });
  };
  return { fetch, sent };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "bandwise-live-"));

describe("setSlug", () => {
  it("drops .spec.json or .json", () => {
    expect(setSlug("/a/b/done-check.json")).toBe("done-check");
    expect(setSlug("examples/email-triage.spec.json")).toBe("email-triage");
  });
});

describe("readProviderKey", () => {
  it("reads only the matching variable and names it when missing, never a value", () => {
    expect(readProviderKey("typesafe", ENV)).toEqual({ ok: true, apiKey: KEY });
    const missing = readProviderKey("openrouter", ENV);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.message).toContain("OPENROUTER_API_KEY");
    expect(JSON.stringify(missing)).not.toContain(KEY);
    expect(readProviderKey("vercel", { AI_GATEWAY_API_KEY: "  " }).ok).toBe(false);
  });
});

describe("bandwise run --live", () => {
  it("refuses with the variable name when the key is missing, and sends nothing", async () => {
    const { fetch, sent } = fakeFetch();
    const out = await main(["run", "--live", DEMO_SPEC, DEMO_STATE], { env: {}, fetch });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("TYPESAFE_API_KEY is not set");
    expect(sent).toHaveLength(0);
  });

  it("runs against the TypeSafe base URL with the key from the environment only", async () => {
    const { fetch, sent } = fakeFetch({ is_urgent: { type: "noul", noul: 0.97 } });
    const out = await main(["run", "--live", DEMO_SPEC, DEMO_STATE, "--json"], { env: ENV, fetch });
    expect(out.exitCode).toBe(0);
    const result = RunResult.parse(JSON.parse(out.stdout));
    expect(result.status).toBe("ok");
    expect(result.typesafeRequestId).toBe("req_unit");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/^https:\/\/api\.typesafe\.ai\//);
    expect(sent[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(out.stdout).not.toContain(KEY);
  });

  it("appends a receipt with no state when asked", async () => {
    const dir = tmp();
    const path = join(dir, "r.jsonl");
    const { fetch } = fakeFetch();
    const out = await main(["run", "--live", DEMO_SPEC, DEMO_STATE, `--receipts=${path}`], { env: ENV, fetch });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("receipt appended");
    const { receipts } = readReceipts(path);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ set: setSlug(DEMO_SPEC), source: "run", provider: "typesafe", status: "ok", acted: false });
    expect(receipts[0]?.specHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    const state = JSON.parse(readFileSync(DEMO_STATE, "utf8")) as Record<string, unknown>;
    const text = readFileSync(path, "utf8");
    for (const v of Object.values(state)) {
      if (typeof v === "string" && v.length > 12) expect(text).not.toContain(v);
    }
  });

  it("a provider error becomes a failed envelope, not a crash", async () => {
    const { fetch } = fakeFetch({}, { status: 401 });
    const out = await main(["run", "--live", DEMO_SPEC, DEMO_STATE, "--json"], { env: ENV, fetch });
    expect(out.exitCode).toBe(1);
    expect(RunResult.parse(JSON.parse(out.stdout)).error?.code).toBe("system_one_auth");
    expect(out.stdout).not.toContain(KEY);
  });
});

describe("redaction and state shaping", () => {
  it("replaces secret-shaped text", () => {
    // Secret-shaped samples are assembled at run time, so no literal key shape sits in the source.
    const j = (...parts: string[]): string => parts.join("");
    const text = [
      `export OPENAI_API_KEY=${j("sk-", "proj-", "abcdefghijklmnopqrstuvwx")}`,
      "curl -H 'Authorization: Bearer abc.def.ghi-123456'",
      `token ${j("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123")}`,
      `aws ${j("AK", "IA", "ABCDEFGHIJKLMNOP")}`,
      j("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow\n-----END RSA ", "PRIVATE KEY-----"),
      'password: "hunter2"',
      "opaque Zx9aQ2bR7cT4dU1eV8fW3gX6hY0iJ5kL",
    ].join("\n");
    const out = redactSecrets(text);
    for (const secret of ["sk-proj-abc", "abc.def.ghi", "ghp_abc", "AKIAABC", "MIIEow", "hunter2", "Zx9aQ2bR7c"]) expect(out).not.toContain(secret);
    expect(out).toContain("OPENAI_API_KEY=[redacted]");
  });

  it("replaces short secrets in JSON fields, auth headers, CLI flags and URLs", () => {
    // Connection strings are assembled at run time, so no literal credential URL sits in the source.
    const pg = (password: string): string => ["postgres", "://app:", password, "@db:5432/app"].join("");
    const cases: Array<[string, string]> = [
      ['{"apiKey": "abc123"}', "abc123"],
      ["{'client_secret': 'tiny'}", "tiny"],
      ["api-token: zz9", "zz9"],
      ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["-H 'Proxy-Authorization: Digest a1b2'", "a1b2"],
      ["curl --api-key s3cr3t https://example.com", "s3cr3t"],
      ["tool -p hunter2 --password hunter3", "hunter3"],
      [`psql ${pg("hunter2")}`, "hunter2"],
      ["https://user:pa55@example.com/x", "pa55"],
    ];
    for (const [text, secret] of cases) expect(redactSecrets(text), text).not.toContain(secret);
    expect(redactSecrets("curl --api-key s3cr3t https://example.com")).toBe("curl --api-key [redacted] https://example.com");
    expect(redactSecrets(`psql ${pg("hunter2")}`)).toBe(`psql ${pg("[redacted]")}`);
  });

  it("keeps commit ids and ordinary words", () => {
    const sha = "9b8be065afb60ec56bb262b7488f9dc7de853925";
    expect(redactSecrets(`git show ${sha}`)).toBe(`git show ${sha}`);
    expect(redactSecrets("pnpm --filter @bandwise/cli test")).toBe("pnpm --filter @bandwise/cli test");
  });

  it("sends only the fields the schema names, cut to maxLength", () => {
    const schema = { type: "object", properties: { prompt: { type: "string", maxLength: 5 }, n: { type: "number" }, gone: { type: "string" } } };
    expect(shapeState({ prompt: "abcdefgh", n: 3, secret: "x", gone: "y" }, schema, ["gone"])).toEqual({ prompt: "abcde", n: 3 });
  });
});

describe("hook input mapping", () => {
  const transcript = [
    JSON.stringify({ type: "user", message: { role: "user", content: "Fix the flaky export test" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<meta>" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixed and ran pnpm test: 12 passed." }] } }),
  ].join("\n");

  it("takes the last typed request and the final reply from a transcript", () => {
    expect(lastExchange(`{"cut line\n${transcript}`)).toEqual({ request: "Fix the flaky export test", lastReply: "Fixed and ran pnpm test: 12 passed." });
  });

  it("maps each event and skips what it should", () => {
    const read = (): string => transcript;
    expect(mapHookInput("Stop", { transcript_path: "/t.jsonl" }, read)).toEqual({
      kind: "run",
      candidate: { request: "Fix the flaky export test", last_reply: "Fixed and ran pnpm test: 12 passed." },
      task: { requestAt: null, turns: 2, toolCalls: 1 },
    });
    expect(mapHookInput("Stop", { transcript_path: "/t.jsonl", stop_hook_active: true }, read)).toEqual({ kind: "skip" });
    expect(mapHookInput("UserPromptSubmit", { prompt: "rename foo" }, read)).toEqual({ kind: "run", candidate: { prompt: "rename foo" } });
    expect(mapHookInput("UserPromptSubmit", { prompt: " " }, read)).toEqual({ kind: "skip" });
    expect(mapHookInput("PreToolUse", { tool_name: "Read", tool_input: { file_path: "a" } }, read)).toEqual({ kind: "skip" });
    expect(mapHookInput("PreToolUse", { tool_name: "Bash", tool_input: { command: "git status" } }, read)).toEqual({ kind: "skip" });
    expect(mapHookInput("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf dist", description: "clean" } }, read)).toMatchObject({
      kind: "run",
      candidate: { tool: "Bash", command: "rm -rf dist", description: "clean" },
    });
    expect(mapHookInput("PreToolUse", { tool_name: "Edit", tool_input: { file_path: ".env", new_string: "A=1" } }, read)).toMatchObject({
      kind: "run",
      candidate: { tool: "Edit", file_path: ".env", content_preview: "A=1" },
    });
  });

  it("counts turns and tool calls since the last typed request", () => {
    const line = (x: unknown): string => JSON.stringify(x);
    const t = [
      line({ type: "user", timestamp: "2026-09-30T12:00:00.000Z", message: { content: "Old request" } }),
      line({ type: "assistant", message: { id: "m0", content: [{ type: "tool_use", name: "Bash" }] } }),
      line({ type: "user", timestamp: "2026-09-30T12:05:00.000Z", message: { content: "Add the compare report" } }),
      // Claude Code writes one line per content block; lines with one message id are one turn.
      line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Reading." }] } }),
      line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read" }, { type: "tool_use", name: "Grep" }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      line({ type: "assistant", isSidechain: true, message: { id: "s1", content: [{ type: "tool_use", name: "Bash" }] } }),
      line({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Edit" }] } }),
      line({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n");
    expect(taskStats(`{"cut\n${t}`)).toEqual({ requestAt: Date.parse("2026-09-30T12:05:00.000Z"), turns: 3, toolCalls: 3 });
    expect(taskStats(line({ type: "assistant", message: { content: "no request in the tail" } }))).toBeNull();
  });

  it("reads a launch profile only when it looks like a profile id", () => {
    expect(readLaunchProfile({ BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "light-1.2" })).toEqual({ profile: "standard", picked: "light-1.2" });
    expect(readLaunchProfile({ BANDWISE_LAUNCH_PROFILE: "rm -rf /", BANDWISE_LAUNCH_PICKED: "" })).toEqual({ profile: null, picked: null });
    expect(readLaunchProfile({})).toEqual({ profile: null, picked: null });
  });

  it("trusts plain reads only", () => {
    expect(isTrustedCommand("ls -la")).toBe(true);
    expect(isTrustedCommand("git diff main")).toBe(true);
    expect(isTrustedCommand("cat a > b")).toBe(false);
    expect(isTrustedCommand("git status; rm -rf /")).toBe(false);
    expect(isTrustedCommand("find . -delete")).toBe(false);
    expect(isTrustedCommand("git push")).toBe(false);
  });
});

describe("bandwise hook", () => {
  const cmd = (over: Partial<HookCommand> = {}): HookCommand => ({
    event: "PreToolUse",
    setPath: join(SETS, "action-risk-gate.json"),
    rollout: "shadow",
    provider: "typesafe",
    timeoutMs: 3000,
    receiptsPath: join(tmp(), "r.jsonl"),
    drop: [],
    ...over,
  });
  const forcePush = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin main", description: "push" } });
  const risky = { risky_command: { type: "noul", noul: 0.99 } };

  it("in shadow never answers, even when the set would ask, and writes a receipt", async () => {
    const { fetch, sent } = fakeFetch(risky);
    const c = cmd();
    const out = await runHook(c, { stdin: async () => forcePush, env: ENV, transport: () => liveTransport({ fetch }) });
    expect(out).toEqual({ exitCode: 0, stdout: "" });
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.body.state ?? {}).sort()).toEqual(["command", "description", "tool"]);
    const { receipts } = readReceipts(c.receiptsPath);
    expect(receipts[0]).toMatchObject({ set: "action-risk-gate", source: "PreToolUse", rollout: "shadow", route: "ask", acted: false });
    expect(readFileSync(c.receiptsPath, "utf8")).not.toContain("git push");
  });

  it("in controlled a high band ask becomes a permission ask", async () => {
    const { fetch } = fakeFetch(risky);
    const c = cmd({ rollout: "controlled" });
    const out = await runHook(c, { stdin: async () => forcePush, env: ENV, transport: () => liveTransport({ fetch }) });
    expect(JSON.parse(out.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } });
    expect(readReceipts(c.receiptsPath).receipts[0]?.acted).toBe(true);
  });

  it("in controlled a medium band answer stays quiet", async () => {
    const { fetch } = fakeFetch({ risky_command: { type: "noul", noul: 0.8 } });
    const out = await runHook(cmd({ rollout: "controlled" }), { stdin: async () => forcePush, env: ENV, transport: () => liveTransport({ fetch }) });
    expect(out.stdout).toBe("");
  });

  it("with no key it is off: no call and no receipt", async () => {
    const { fetch, sent } = fakeFetch();
    const c = cmd();
    const out = await runHook(c, { stdin: async () => forcePush, env: {}, transport: () => liveTransport({ fetch }) });
    expect(out).toEqual({ exitCode: 0, stdout: "" });
    expect(sent).toHaveLength(0);
    expect(readReceipts(c.receiptsPath).receipts).toHaveLength(0);
  });

  it("exits 0 with no output on a timeout, and records it", async () => {
    const { fetch } = fakeFetch(risky, { delayMs: 5_000 });
    const c = cmd({ rollout: "controlled", timeoutMs: 150 });
    const started = Date.now();
    const out = await runHook(c, { stdin: async () => forcePush, env: ENV, transport: () => liveTransport({ fetch }) });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toEqual({ exitCode: 0, stdout: "" });
    expect(readReceipts(c.receiptsPath).receipts[0]).toMatchObject({ status: "timeout", acted: false });
  });

  it("exits 0 with no output on bad input, a bad set or a provider error", async () => {
    const { fetch } = fakeFetch({}, { status: 500 });
    const deps = { env: ENV, transport: () => liveTransport({ fetch }) };
    expect(await runHook(cmd(), { ...deps, stdin: async () => "not json" })).toEqual({ exitCode: 0, stdout: "" });
    expect(await runHook(cmd({ setPath: "/nope.json" }), { ...deps, stdin: async () => forcePush })).toEqual({ exitCode: 0, stdout: "" });
    expect(await runHook(cmd({ rollout: "full" }), { ...deps, stdin: async () => forcePush })).toEqual({ exitCode: 0, stdout: "" });
  });

  it("exits 0 with no output when the live module cannot load", async () => {
    const out = await main(["hook", "Stop", "--set", join(SETS, "done-check.json")], {
      env: ENV,
      stdin: async () => "{}",
      loadLive: async () => {
        throw new Error("Cannot find module '@typesafe-ai/sdk'");
      },
    });
    expect(out).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("a bad hook command line exits 0 with no output", async () => {
    expect(await main(["hook", "Nope"])).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(await main(["hook", "Stop"])).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("a Stop receipt carries the task's counts and the launch profile, never its text", async () => {
    const transcriptPath = join(tmp(), "t.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", timestamp: "2026-09-30T12:00:00.000Z", message: { content: "Refactor the billing module" } }),
        JSON.stringify({ type: "assistant", message: { id: "a1", content: [{ type: "tool_use", name: "Edit" }] } }),
        JSON.stringify({ type: "assistant", message: { id: "a2", content: [{ type: "text", text: "Refactored and ran the tests." }] } }),
      ].join("\n"),
    );
    const { fetch } = fakeFetch();
    const c = cmd({ event: "Stop", setPath: join(SETS, "done-check.json") });
    await runHook(c, {
      stdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcriptPath }),
      env: { ...ENV, BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "light" },
      transport: () => liveTransport({ fetch }),
      now: () => Date.parse("2026-09-30T12:01:30.000Z"),
    });
    const { receipts } = readReceipts(c.receiptsPath);
    expect(receipts[0]?.session).toEqual({ key: fnv1a64("sess-1"), taskMs: 90_000, turns: 2, toolCalls: 1, profile: "standard", profilePicked: "light" });
    const file = readFileSync(c.receiptsPath, "utf8");
    expect(file).not.toContain("billing");
    expect(file).not.toContain("sess-1");

    // Other events carry no session block.
    const p = cmd();
    await runHook(p, { stdin: async () => forcePush, env: ENV, transport: () => liveTransport({ fetch }) });
    expect(readReceipts(p.receiptsPath).receipts[0]?.session).toBeUndefined();
  });

  it("Stop and UserPromptSubmit answers, outside shadow", async () => {
    const transcriptPath = join(tmp(), "t.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", message: { content: "Fix the export and run its tests" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Changed the loop. This should work now." }] } }),
      ].join("\n"),
    );
    const stop = fakeFetch({ turn_outcome: { type: "choice", choice: "unverified", confidence: 0.9, probabilities: { finished: 0.02, unverified: 0.92, work_left: 0.03, waiting_on_user: 0.02, unclear: 0.01 } } });
    const out = await main(["hook", "Stop", "--set", join(SETS, "done-check.json"), "--rollout", "controlled", "--receipts", join(tmp(), "r.jsonl")], {
      env: ENV,
      fetch: stop.fetch,
      stdin: async () => JSON.stringify({ hook_event_name: "Stop", transcript_path: transcriptPath, stop_hook_active: false }),
    });
    expect(JSON.parse(out.stdout)).toMatchObject({ decision: "block" });
    expect(stop.sent[0]?.body.state).toEqual({ request: "Fix the export and run its tests", last_reply: "Changed the loop. This should work now." });

    const tier = fakeFetch({ difficulty: { type: "score", score: 0.05, confidence: 0.95, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.95, "1": 0.04, "2": 0.01 } } });
    const prompt = await main(["hook", "UserPromptSubmit", "--set", join(SETS, "model-tier.json"), "--rollout", "full", "--receipts", join(tmp(), "r.jsonl")], {
      env: ENV,
      fetch: tier.fetch,
      stdin: async () => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Rename getUser to fetchUser everywhere" }),
    });
    expect(JSON.parse(prompt.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
  });

  it("hookResponse never acts in shadow", () => {
    const result = { status: "ok", overallAction: "auto", route: "ask", decisions: {} } as unknown as RunResult;
    expect(hookResponse("PreToolUse", "shadow", result)).toBeNull();
    expect(hookResponse("PreToolUse", "controlled", result)).not.toBeNull();
    expect(hookResponse("PreToolUse", "controlled", { ...result, overallAction: "review" })).toBeNull();
  });
});

describe("the key rule", () => {
  it("only live/key.ts reads a provider key variable, and only remote/credentials.ts the Bandwise token", () => {
    const src = at("../");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "__fixtures__" ? [] : files(join(dir, e.name))) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
    const readers = (re: RegExp): string[] => files(src).filter((f) => re.test(readFileSync(f, "utf8")) && !f.endsWith("main.ts")).map((f) => f.slice(src.length));
    expect(readers(/TYPESAFE_API_KEY|OPENROUTER_API_KEY|AI_GATEWAY_API_KEY/)).toEqual(["live/key.ts"]);
    expect(readers(/process\.env/)).toEqual(["live/key.ts", "remote/credentials.ts"]);
    expect(readers(/"BANDWISE_TOKEN"|"BANDWISE_BASE_URL"/)).toEqual(["remote/credentials.ts"]);
    // main.ts only names the variables in its usage text; it never reads process.env.
    expect(readFileSync(join(src, "main.ts"), "utf8")).not.toContain("process.env");
  });

  it("no CLI module starts a program until live/spawn.ts exists", () => {
    const src = at("../");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
    const importers = files(src).filter((f) => /["'](?:node:)?child_process["']/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.slice(src.length)).filter((f) => f !== "live/spawn.ts")).toEqual([]);
  });

  it("only live/transport.ts imports system-one-client outside local mode's fixture subpath", () => {
    const src = at("../");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "__fixtures__" ? [] : files(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const importers = files(src).filter((f) => /from "@bandwise\/system-one-client"/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.slice(src.length))).toEqual(["live/transport.ts"]);
  });
});

describe("redaction parity with core", () => {
  // Hosted hook mode loads without @bandwise/core, so the CLI keeps its own copy of the rules. The
  // server's MCP path uses core's. Both must redact the same way.
  it("keeps live/redact.ts identical to packages/core/src/redact/index.ts below the header", () => {
    const body = (file: URL): string => {
      const text = readFileSync(file, "utf8");
      return text.slice(text.indexOf("const SECRET_PATTERNS"));
    };
    const cli = body(new URL("./redact.ts", import.meta.url));
    const core = body(new URL("../../../core/src/redact/index.ts", import.meta.url));
    expect(cli.length).toBeGreaterThan(0);
    expect(cli).toBe(core);
  });
});
