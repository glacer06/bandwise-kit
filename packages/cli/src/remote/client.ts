// The HTTP client for /api/v1. It sends `Authorization: Bearer <token>`, an Idempotency-Key on
// every write, and If-Match when asked. Reads retry 429, retryable 503s and network errors.
// Writes retry 429 and retryable 503s with the same key, never a network error. Every failure
// comes back as one ApiError in the documented envelope's shape, so commands print one kind of error.
// The token is never part of an error.

import type { Remote } from "./credentials.js";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ErrorDetail {
  path: string;
  rule: string;
  severity?: string;
  message: string;
}

export interface GateResult {
  id: string;
  required: unknown;
  actual: unknown;
  met: boolean;
}

/** An the design docs error envelope, or one the client built for a failure that never reached the API. */
export interface ApiError {
  /** HTTP status, or null when no answer came back. */
  status: number | null;
  code: string;
  message: string;
  requestId: string | null;
  retryable: boolean;
  details: ErrorDetail[];
  gates: GateResult[];
  requiredScope: string | null;
  currentEtag: string | null;
}

export type ApiResult = { ok: true; status: number; body: unknown; etag: string | null } | { ok: false; error: ApiError };

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** The draft ETag, quoted or not. */
  ifMatch?: string;
  signal?: AbortSignal;
  /** False turns retries off, for the hook's tight budget. */
  retry?: boolean;
}

export interface ClientDeps {
  fetch?: FetchFn;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Per request, unless the caller passes its own signal. */
  timeoutMs?: number;
}

export interface ApiClient {
  readonly baseUrl: string;
  request(method: "GET" | "POST" | "PUT", path: string, opts?: RequestOptions): Promise<ApiResult>;
}

const MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const strOr = (x: unknown, fallback: string | null): string | null => (typeof x === "string" && x !== "" ? x : fallback);

/** `"abc"` and `W/"abc"` to `abc`, for display and comparison. */
export function unquoteEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

/** An ETag as If-Match sends it: quoted. */
export function quoteEtag(etag: string): string {
  return /^(W\/)?".*"$/.test(etag) ? etag : `"${etag}"`;
}

/** Build a path with each parameter encoded: path`/sets/${ref}/draft`. */
export function path(strings: TemplateStringsArray, ...params: Array<string | number>): string {
  return strings.reduce((out, s, i) => out + s + (i < params.length ? encodeURIComponent(String(params[i])) : ""), "");
}

function clientError(code: string, message: string, status: number | null = null, retryable = false): ApiError {
  return { status, code, message, requestId: null, retryable, details: [], gates: [], requiredScope: null, currentEtag: null };
}

/** Read an error envelope. A body that is not one becomes an `http_<status>` error. */
export function toApiError(status: number, body: unknown): ApiError {
  const e = isObj(body) && isObj(body["error"]) ? body["error"] : null;
  if (e === null || typeof e["code"] !== "string") return clientError(`http_${status}`, `the server answered HTTP ${status} without an error envelope`, status, status === 503);
  const details = Array.isArray(e["details"])
    ? e["details"].filter(isObj).map((d) => ({ path: String(d["path"] ?? ""), rule: String(d["rule"] ?? ""), message: String(d["message"] ?? ""), ...(typeof d["severity"] === "string" ? { severity: d["severity"] } : {}) }))
    : [];
  const gates = Array.isArray(e["gates"]) ? e["gates"].filter(isObj).map((g) => ({ id: String(g["id"] ?? ""), required: g["required"], actual: g["actual"], met: g["met"] === true })) : [];
  return {
    status,
    code: e["code"],
    message: typeof e["message"] === "string" ? e["message"] : "",
    requestId: strOr(e["requestId"], null),
    retryable: e["retryable"] === true,
    details,
    gates,
    requiredScope: strOr(e["requiredScope"], null),
    currentEtag: strOr(e["currentEtag"], null),
  };
}

/** A network error names its system code (ENOTFOUND, ECONNREFUSED) and nothing else. */
function networkMessage(e: unknown, host: string): string {
  const cause = isObj(e) && isObj(e["cause"]) ? e["cause"] : null;
  const code = cause !== null && typeof cause["code"] === "string" && /^[A-Z_]+$/.test(cause["code"]) ? cause["code"] : null;
  return `could not reach ${host}${code !== null ? ` (${code})` : ""}`;
}

function retryAfterMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? Math.min(header, 5) * 1000 : 300 * 3 ** attempt;
}

export function createClient(remote: Remote, deps: ClientDeps = {}): ApiClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const host = new URL(remote.baseUrl).host;

  return {
    baseUrl: remote.baseUrl,
    async request(method, apiPath, opts = {}) {
      const url = new URL(`${remote.baseUrl}/api/v1${apiPath}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = { authorization: `Bearer ${remote.token}`, accept: "application/json" };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      // One key for every attempt. The server stores each write's response under its key in the
      // write's own transaction, so a retry with the same key after a 503 (which can come after a
      // commit) replays the committed answer instead of running the write again. A 429 comes
      // before anything runs. POST /sets/{ref}/run has its own route, which does not store keys
      // yet, so a run is not retried on a 503.
      if (method !== "GET") headers["idempotency-key"] = newId();
      if (opts.ifMatch !== undefined) headers["if-match"] = quoteEtag(opts.ifMatch);
      const retries = opts.retry === false ? 0 : MAX_RETRIES;
      const replaysOn503 = method === "GET" || !/^\/sets\/[^/]+\/run$/.test(apiPath);

      for (let attempt = 0; ; attempt++) {
        const signal = opts.signal ?? AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        let res: Response;
        try {
          // redirect "error": the bearer header is never replayed to wherever a redirect points.
          res = await doFetch(url.href, { method, headers, signal, redirect: "error", ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
        } catch (e) {
          if (signal.aborted) return { ok: false, error: clientError("timeout", `${host} did not answer in time`, null, true) };
          // A write that died on the wire may have landed, and a timeout may have cut it off
          // mid-flight. Writes are not retried here; the caller checks with a read first.
          if (method === "GET" && attempt < retries) {
            await sleep(300 * 3 ** attempt);
            continue;
          }
          return { ok: false, error: clientError("network_error", networkMessage(e, host), null, true) };
        }
        const text = await res.text().catch(() => "");
        let body: unknown = null;
        let parsed = text === "";
        if (!parsed) {
          try {
            body = JSON.parse(text);
            parsed = true;
          } catch {
            // Not JSON: a proxy page or a crash. Handled below.
          }
        }
        if (res.ok) {
          if (!parsed) return { ok: false, error: clientError("bad_response", `${host} answered HTTP ${res.status} with a body that is not JSON`, res.status) };
          const etag = res.headers.get("etag");
          return { ok: true, status: res.status, body, etag: etag === null ? null : unquoteEtag(etag) };
        }
        const error = toApiError(res.status, parsed ? body : null);
        const again = res.status === 429 || (replaysOn503 && res.status === 503 && (error.retryable || error.code === "http_503"));
        if (again && attempt < retries) {
          await sleep(retryAfterMs(res, attempt));
          continue;
        }
        return { ok: false, error };
      }
    },
  };
}
