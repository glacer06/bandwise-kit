import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../main.js";
import { createClient, toApiError } from "./client.js";
import { parseBaseUrl, readRemote, scrubToken } from "./credentials.js";
import { diffJson } from "./json-diff.js";
import { ROLLBACK_REPLY, USAGE_REPLY } from "./__fixtures__/replies.js";

// Built from parts so the kit export scanner does not read it as a real token.
const TOKEN = ["sa", "live", "0123456789abcdef0123456789abcdef", "unitTestSecretValue"].join("_");
const ENV = { BANDWISE_TOKEN: TOKEN };
const BASE = "https://app.bandwise.dev";

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; text?: string };
type Route = (req: Seen) => Reply | undefined;

/** A fake /api/v1. Routes answer by method and path; anything else is 404 not_found. */
function fakeApi(routes: Record<string, Route | Reply>): { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api\/v1/, ""),
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    seen.push(req);
    const route = routes[`${req.method} ${req.path}`];
    const reply = typeof route === "function" ? route(req) : route;
    const r = reply ?? { status: 404, body: { error: { code: "not_found", message: "No such set.", requestId: "req_1", retryable: false } } };
    return new Response(r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body)), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  };
  return { fetch, seen };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "bandwise-remote-"));
const SPEC = { model: "jev-1.13.0", input: { schema: { type: "object", properties: { prompt: { type: "string" } } } }, questions: { q1: { type: "noul", text: "Is it urgent?" } } };

function specFile(name = "triage.json", spec: unknown = SPEC): string {
  const file = join(tmp(), name);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

/** No output, on any stream, ever holds the token. */
function noToken(out: { stdout: string; stderr: string }): void {
  expect(out.stdout).not.toContain(TOKEN);
  expect(out.stderr).not.toContain(TOKEN);
}

describe("credentials", () => {
  it("reads the token and defaults the base URL", () => {
    expect(readRemote({})).toEqual({ kind: "none" });
    expect(readRemote({ BANDWISE_TOKEN: "  " })).toEqual({ kind: "none" });
    expect(readRemote(ENV)).toEqual({ kind: "ok", remote: { token: TOKEN, baseUrl: BASE } });
    expect(readRemote({ ...ENV, BANDWISE_BASE_URL: "http://[::1]:3000/" })).toEqual({ kind: "ok", remote: { token: TOKEN, baseUrl: "http://[::1]:3000" } });
  });

  it("refuses a token with spaces and never echoes it", () => {
    const out = readRemote({ BANDWISE_TOKEN: "sa_live_abc def_secret" });
    expect(out.kind).toBe("error");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("allows https, and http only on this machine", () => {
    expect(parseBaseUrl("http://app.bandwise.dev").ok).toBe(false);
    expect(parseBaseUrl("https://user:pw@example.com").ok).toBe(false);
    expect(parseBaseUrl("https://app.bandwise.dev?x=1").ok).toBe(false);
    expect(parseBaseUrl("not a url").ok).toBe(false);
    expect(parseBaseUrl("http://[::1]")).toEqual({ ok: true, baseUrl: "http://[::1]" });
  });

  it("scrubs every copy of the token", () => {
    expect(scrubToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a [redacted] b [redacted]");
  });
});

describe("client", () => {
  const remote = { token: TOKEN, baseUrl: BASE };

  it("sends the bearer token, one idempotency key per write across retries, and If-Match quoted", async () => {
    let calls = 0;
    const api = fakeApi({
      "PUT /sets/triage/draft": () => (++calls === 1 ? { status: 429, body: { error: { code: "rate_limited", message: "slow down", requestId: "r", retryable: true } } } : { status: 200, body: { etag: "e2" } }),
    });
    const slept: number[] = [];
    const client = createClient(remote, { fetch: api.fetch, newId: () => "idem-1", sleep: async (ms) => void slept.push(ms) });
    const res = await client.request("PUT", "/sets/triage/draft", { body: {}, ifMatch: "e1" });
    expect(res).toMatchObject({ ok: true, status: 200, body: { etag: "e2" } });
    expect(api.seen.map((s) => s.headers["idempotency-key"])).toEqual(["idem-1", "idem-1"]);
    expect(api.seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(api.seen[0]?.headers["if-match"]).toBe('"e1"');
    expect(slept).toHaveLength(1);
  });

  it("retries a write on a retryable 503 with the same key, so the server replays a committed write", async () => {
    let calls = 0;
    const busy = { status: 503, body: { error: { code: "system_one_unavailable", message: "busy", requestId: "r", retryable: true } } };
    const api = fakeApi({
      "POST /sets/triage/rollback": () => (++calls === 1 ? busy : { status: 200, body: { toVersion: 3 }, headers: { "idempotent-replayed": "true" } }),
      "GET /usage": busy,
    });
    const client = createClient(remote, { fetch: api.fetch, newId: () => "idem-1", sleep: async () => undefined });
    expect(await client.request("POST", "/sets/triage/rollback", { body: {} })).toMatchObject({ ok: true, status: 200, body: { toVersion: 3 } });
    const posts = api.seen.filter((x) => x.method === "POST");
    expect(posts.map((x) => x.headers["idempotency-key"])).toEqual(["idem-1", "idem-1"]);
    await client.request("GET", "/usage");
    expect(api.seen.filter((x) => x.method === "GET").length).toBeGreaterThan(1);
  });

  it("does not retry a write on a 503 the server marks not retryable", async () => {
    const auth = { status: 503, body: { error: { code: "system_one_auth", message: "key", requestId: "r", retryable: false } } };
    const api = fakeApi({ "POST /sets/triage/rollback": auth });
    const client = createClient(remote, { fetch: api.fetch, newId: () => "idem-1", sleep: async () => undefined });
    expect(await client.request("POST", "/sets/triage/rollback", { body: {} })).toMatchObject({ ok: false, error: { status: 503, code: "system_one_auth" } });
    expect(api.seen).toHaveLength(1);
  });

  it("does not retry a run on a 503: the run route does not store keys", async () => {
    const busy = { status: 503, body: { error: { code: "system_one_unavailable", message: "busy", requestId: "r", retryable: true } } };
    const api = fakeApi({ "POST /sets/triage/run": busy });
    const client = createClient(remote, { fetch: api.fetch, newId: () => "idem-1", sleep: async () => undefined });
    expect(await client.request("POST", "/sets/triage/run", { body: { state: {} } })).toMatchObject({ ok: false, error: { status: 503 } });
    expect(api.seen).toHaveLength(1);
  });

  it("refuses to follow redirects, so the bearer header goes only to the configured host", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const client = createClient(remote, {
      fetch: async (_url, init) => {
        inits.push(init);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.request("GET", "/usage");
    expect(inits[0]?.redirect).toBe("error");
  });

  it("does not retry when retry is off, and sends no idempotency key on a read", async () => {
    const api = fakeApi({ "GET /usage": { status: 429, body: { error: { code: "rate_limited", message: "slow down", requestId: "r", retryable: true } } } });
    const client = createClient(remote, { fetch: api.fetch, sleep: async () => undefined });
    const res = await client.request("GET", "/usage", { retry: false });
    expect(res).toMatchObject({ ok: false, error: { code: "rate_limited", status: 429 } });
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("names a network failure by its code only", async () => {
    const fetch = async (): Promise<Response> => {
      throw Object.assign(new TypeError(`fetch failed for ${TOKEN}`), { cause: { code: "ENOTFOUND" } });
    };
    const client = createClient(remote, { fetch, sleep: async () => undefined });
    const res = await client.request("GET", "/usage");
    expect(res).toMatchObject({ ok: false, error: { code: "network_error", message: "could not reach app.bandwise.dev (ENOTFOUND)" } });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("retries a read after a network error, but never a write, which may have landed", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    };
    const client = createClient(remote, { fetch, sleep: async () => undefined });
    await client.request("GET", "/usage");
    expect(calls).toBe(3);
    calls = 0;
    const res = await client.request("POST", "/sets/triage/channels/production/rollback", { body: {} });
    expect(res).toMatchObject({ ok: false, error: { code: "network_error" } });
    expect(calls).toBe(1);
  });

  it("reads the envelope, and a body that is not one", () => {
    expect(toApiError(412, { error: { code: "precondition_failed", message: "changed", requestId: "r", retryable: false, currentEtag: '"e9"' } })).toMatchObject({ code: "precondition_failed", currentEtag: '"e9"' });
    expect(toApiError(502, null)).toMatchObject({ code: "http_502", status: 502 });
  });
});

describe("diffJson", () => {
  it("lists adds, removes and replaces with JSON Pointers", () => {
    expect(diffJson({ a: 1, b: { "x/y": [1, 2] }, c: 3 }, { a: 2, b: { "x/y": [1] }, d: 4 })).toEqual([
      { path: "/a", op: "replace", before: 1, after: 2 },
      { path: "/b/x~1y/1", op: "remove", before: 2 },
      { path: "/c", op: "remove", before: 3 },
      { path: "/d", op: "add", after: 4 },
    ]);
    expect(diffJson({ a: [1] }, { a: [1] })).toEqual([]);
  });
});

describe("parseArgs for remote commands", () => {
  it("parses each command and its defaults", () => {
    expect(parseArgs(["spec", "pull", "triage", "--out", "t.json"])).toEqual({ kind: "spec-pull", set: "triage", out: "t.json", json: false });
    expect(parseArgs(["spec", "push", "t.json", "--goal", "g", "--json"])).toEqual({ kind: "spec-push", file: "t.json", goal: "g", json: true });
    expect(parseArgs(["spec", "diff", "t.json", "--version", "3"])).toEqual({ kind: "spec-diff", file: "t.json", version: 3, json: false });
    expect(parseArgs(["publish", "triage"])).toEqual({ kind: "publish", set: "triage", channel: "production", json: false });
    expect(parseArgs(["rollback", "triage", "--channel", "staging", "--to", "2"])).toEqual({ kind: "rollback", set: "triage", channel: "staging", to: 2, json: false });
    expect(parseArgs(["rollout", "triage", "controlled", "--reason", "week one"])).toEqual({ kind: "rollout", set: "triage", stage: "controlled", channel: "production", reason: "week one", json: false });
    expect(parseArgs(["report", "--remote", "--since", "7d"])).toEqual({ kind: "report-remote", since: { text: "7d", ms: 7 * 86_400_000 }, json: false });
    expect(parseArgs(["hook", "Stop", "--set", "s.json", "--remote-set", "done"])).toMatchObject({ kind: "hook", remoteSet: "done" });
  });

  it("refuses bad input", () => {
    expect(parseArgs(["spec", "edit", "x"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["spec", "pull"])).toMatchObject({ kind: "error", message: "bandwise spec pull needs a set" });
    expect(parseArgs(["rollout", "triage", "live"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["rollout", "triage"])).toMatchObject({ kind: "error", message: "bandwise rollout needs a set and a stage" });
    expect(parseArgs(["publish", "triage", "--channel", "dev"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["rollback", "triage", "--to", "0"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["spec", "push", "t.json", "--name", "T"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["report", "--remote", "--compare", "profile"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["publish", "triage", "--force", "x"])).toMatchObject({ kind: "error", message: "unknown option --force" });
  });
});

describe("remote commands", () => {
  it("needs BANDWISE_TOKEN and says so", async () => {
    const out = await main(["publish", "triage"], { env: {} });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("BANDWISE_TOKEN is not set");
  });

  it("spec pull prints the draft, writes --out, and --json carries the etag", async () => {
    const api = fakeApi({ "GET /sets/triage/draft": { status: 200, body: SPEC, headers: { etag: '"e1"' } } });
    const printed = await main(["spec", "pull", "triage"], { env: ENV, fetch: api.fetch });
    expect(printed).toMatchObject({ exitCode: 0, stderr: "draft etag e1" });
    expect(JSON.parse(printed.stdout)).toEqual(SPEC);

    const out = join(tmp(), "triage.json");
    const written = await main(["spec", "pull", "triage", "--out", out], { env: ENV, fetch: api.fetch });
    expect(written.stdout).toBe(`Wrote the triage draft to ${out} (etag e1).`);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(SPEC);

    const asJson = await main(["spec", "pull", "triage", "--json"], { env: ENV, fetch: api.fetch });
    expect(JSON.parse(asJson.stdout)).toEqual({ set: "triage", etag: "e1", spec: SPEC });
  });

  it("spec push replaces the draft with If-Match from draft.get and shows lint results", async () => {
    const api = fakeApi({
      "GET /sets/triage/draft": { status: 200, body: SPEC, headers: { etag: '"e1"' } },
      "PUT /sets/triage/draft": { status: 200, body: { etag: "e2" } },
      "POST /sets/triage/draft/validate": { status: 200, body: { errors: [], warnings: [{ path: "/model", rule: "model.unpinned", severity: "warning", message: "Pin a versioned model." }] } },
    });
    const out = await main(["spec", "push", specFile()], { env: ENV, fetch: api.fetch });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("to the triage draft (etag e2).");
    expect(out.stdout).toContain("Lint: 0 errors, 1 warning.");
    expect(out.stdout).toContain("  warning model.unpinned at /model: Pin a versioned model.");
    const put = api.seen.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"e1"');
    expect(put?.body).toEqual(SPEC);
    // No body: an empty one would become the spec the server lints, not the stored draft.
    expect(api.seen.find((s) => s.path.endsWith("/validate"))?.body).toBeUndefined();
  });

  it("spec push creates a missing set with --goal, and refuses without it", async () => {
    let created = false;
    const api = fakeApi({
      "GET /sets/triage/draft": () => (created ? { status: 200, body: SPEC, headers: { etag: '"e0"' } } : undefined),
      "POST /sets": () => {
        created = true;
        return { status: 201, body: { id: "set_1" } };
      },
      "PUT /sets/triage/draft": { status: 200, body: { etag: "e1" } },
      "POST /sets/triage/draft/validate": { status: 200, body: { errors: [], warnings: [] } },
    });
    const without = await main(["spec", "push", specFile()], { env: ENV, fetch: api.fetch });
    expect(without.exitCode).toBe(1);
    expect(without.stderr).toContain("pass --goal <goalId>");

    const out = await main(["spec", "push", specFile(), "--goal", "0193a000-0000-7000-8000-000000000001", "--name", "Triage", "--json"], { env: ENV, fetch: api.fetch });
    expect(JSON.parse(out.stdout)).toEqual({ set: "triage", created: true, etag: "e1", lint: { errors: [], warnings: [] } });
    expect(api.seen.find((s) => s.method === "POST" && s.path === "/sets")?.body).toEqual({ slug: "triage", name: "Triage", goalId: "0193a000-0000-7000-8000-000000000001" });
  });

  it("spec push maps a 412 to one line with the current etag and a next step", async () => {
    const api = fakeApi({
      "PUT /sets/triage/draft": { status: 412, body: { error: { code: "precondition_failed", message: "The draft changed.", requestId: "req_9", retryable: false, currentEtag: '"e7"' } } },
    });
    const out = await main(["spec", "push", specFile(), "--if-match", "e1"], { env: ENV, fetch: api.fetch });
    expect(out.exitCode).toBe(1);
    expect(out.stderr.split("\n")[0]).toBe("error precondition_failed (HTTP 412): The draft changed. [request req_9]");
    expect(out.stderr).toContain("(now e7). Run bandwise spec diff");
    expect(api.seen.map((s) => s.method)).toEqual(["PUT"]);
  });

  it("spec diff exits 0 on a match and 2 on a difference, against the draft or a version", async () => {
    const api = fakeApi({
      "GET /sets/triage/draft": { status: 200, body: SPEC, headers: { etag: '"e1"' } },
      "GET /sets/triage/versions/3": { status: 200, body: { version: 3, spec: { ...SPEC, model: "jev-1.12.0" } } },
    });
    expect(await main(["spec", "diff", specFile()], { env: ENV, fetch: api.fetch })).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("matches the triage draft") });

    const out = await main(["spec", "diff", specFile(), "--version", "3"], { env: ENV, fetch: api.fetch });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain('~ /model: "jev-1.12.0" -> "jev-1.13.0"');

    const asJson = await main(["spec", "diff", specFile("other.json"), "--set", "triage", "--version", "3", "--json"], { env: ENV, fetch: api.fetch });
    expect(asJson.exitCode).toBe(2);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ set: "triage", against: "version 3", changes: [{ path: "/model", op: "replace", before: "jev-1.12.0", after: "jev-1.13.0" }] });
  });

  it("publish sends the draft etag and reports the new version", async () => {
    const api = fakeApi({
      "GET /sets/triage/draft": { status: 200, body: SPEC, headers: { etag: '"e1"' } },
      "POST /sets/triage/publish": { status: 200, body: { version: 4, versionId: "0193a000-0000-7000-8000-000000000004" } },
    });
    const out = await main(["publish", "triage", "--channel", "staging", "--changelog", "Tighter threshold"], { env: ENV, fetch: api.fetch });
    expect(out).toMatchObject({ exitCode: 0, stdout: "Published triage version 4 to staging." });
    const post = api.seen.find((s) => s.method === "POST");
    expect(post?.body).toEqual({ channel: "staging", changelog: "Tighter threshold" });
    expect(post?.headers["if-match"]).toBe('"e1"');
  });

  it("prints the approval id and console link and exits 3 on a 202", async () => {
    const approval = { approval: { id: "0193a000-0000-7000-8000-0000000000aa", status: "pending", url: "https://app.bandwise.dev/approvals/0193a000-0000-7000-8000-0000000000aa", expiresAt: "2026-10-02T00:00:00.000Z" } };
    const api = fakeApi({
      "PUT /sets/triage/channels/production/rollout": { status: 202, body: approval },
      "GET /sets/triage/draft": { status: 200, body: SPEC, headers: { etag: '"e1"' } },
      "POST /sets/triage/publish": { status: 202, body: approval },
    });
    const out = await main(["rollout", "triage", "controlled", "--reason", "A week of clean shadow runs"], { env: ENV, fetch: api.fetch });
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toContain("waiting for approval 0193a000-0000-7000-8000-0000000000aa");
    expect(out.stdout).toContain(approval.approval.url);
    expect(api.seen[0]?.body).toEqual({ stage: "controlled", reason: "A week of clean shadow runs" });

    const asJson = await main(["publish", "triage", "--json"], { env: ENV, fetch: api.fetch });
    expect(asJson.exitCode).toBe(3);
    expect(JSON.parse(asJson.stdout)).toEqual(approval);
  });

  it("rollout prints each gate when one is not met", async () => {
    const api = fakeApi({
      "PUT /sets/triage/channels/production/rollout": {
        status: 409,
        body: { error: { code: "gate_not_met", message: "A gate failed.", requestId: "r", retryable: false, gates: [{ id: "min_labeled_high", required: 50, actual: 12, met: false }] } },
      },
    });
    const out = await main(["rollout", "triage", "controlled"], { env: ENV, fetch: api.fetch });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("gate min_labeled_high: not met (required 50, actual 12)");
  });

  it("rollback posts toVersion, needs no etag, and prints the versions the server moved between", async () => {
    const api = fakeApi({ "POST /sets/triage/channels/production/rollback": { status: 200, body: ROLLBACK_REPLY } });
    const out = await main(["rollback", "triage", "--to", "2"], { env: ENV, fetch: api.fetch });
    expect(out).toMatchObject({ exitCode: 0, stdout: "Rolled back triage on production from version 3 to version 2 (stage shadow)." });
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.body).toEqual({ toVersion: 2 });
    // Without --to, the target still comes from the server's answer.
    expect((await main(["rollback", "triage"], { env: ENV, fetch: api.fetch })).stdout).toContain("to version 2");
  });

  it("report --remote sums usage.get per set for --since and --set, in USD", async () => {
    const api = fakeApi({ "GET /usage": { status: 200, body: USAGE_REPLY } });
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    const out = await main(["report", "--remote", "--since", "1d", "--set", "done-check", "--json"], { env: ENV, fetch: api.fetch, now: () => now });
    expect(out.exitCode).toBe(0);
    expect(api.seen.map((s) => [s.path, s.query])).toEqual([["/usage", { from: "2026-09-30T00:00:00.000Z", set: "done-check" }]]);
    const report = JSON.parse(out.stdout) as { from: string; to: string; sets: Array<{ set: string; runs: number; errors: number; systemOneCostUsd: number; savingsUsd: number }>; totals: { runs: number } };
    expect(report).toMatchObject({ from: USAGE_REPLY.from, to: USAGE_REPLY.to, totals: { runs: 3 } });
    expect(report.sets.map((s) => [s.set, s.runs, s.errors, s.systemOneCostUsd, s.savingsUsd])).toEqual([
      ["done-check", 2, 1, 0.00012, 0.002],
      ["model-tier", 1, 0, 0.00005, 0],
    ]);

    const text = await main(["report", "--remote"], { env: ENV, fetch: api.fetch });
    expect(api.seen.at(-1)?.query).toEqual({});
    expect(text.stdout).toContain("2026-09-30 to 2026-10-01");
    expect(text.stdout).toContain("done-check: 2 runs (1 error), bands high 1 / medium 0 / low 1, System One $0.000120, estimated savings $0.002000, LLM calls avoided 1");
    expect(text.stdout).toContain("total: 3 runs");
  });

  it("never prints the token, even when the server echoes it", async () => {
    const echo = (req: Seen): Reply => ({ status: 401, body: { error: { code: "unauthenticated", message: `bad token ${req.headers["authorization"] ?? ""}`, requestId: "r", retryable: false } } });
    const api = fakeApi({ "GET /sets/triage/draft": echo, "POST /sets/triage/channels/production/rollback": echo });
    for (const argv of [["spec", "pull", "triage"], ["rollback", "triage", "--json"], ["spec", "diff", specFile()]]) {
      const out = await main(argv, { env: ENV, fetch: api.fetch });
      expect(out.exitCode).toBe(1);
      noToken(out);
    }
    const out = await main(["spec", "pull", "triage"], { env: ENV, fetch: api.fetch });
    expect(out.stderr).toContain("check BANDWISE_TOKEN");
  });
});
