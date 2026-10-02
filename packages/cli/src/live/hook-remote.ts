// `bandwise hook` in hosted mode: with BANDWISE_TOKEN set, the hook calls
// POST /api/v1/sets/{slug}/run on Bandwise instead of System One. The local spec file still decides
// which input fields leave the machine (the same schema filter and redaction as live mode). The
// server's rollout stage for the set decides whether the hook may act, so a set moves from shadow
// to controlled in the console with no change to the design docs The same timeout and
// fail-open rule as live mode: any error ends with exit 0 and no output. Receipts keep being
// written, marked remote; they never hold the token. No provider key is read here, and neither
// core nor the SDK is loaded.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunResult } from "@bandwise/core";
import { type Receipt, type ReceiptSession, fnv1a64 } from "../receipts/index.js";
import { type FetchFn, createClient, path } from "../remote/client.js";
import type { Remote } from "../remote/credentials.js";
import { type HookEvent, type HookOutput, type HookRollout, SILENT, guardHook, hookResponse, isObj, prepareHook } from "./hook-input.js";
import { failureReceipt, receiptFromResult } from "./receipt-from-result.js";

export interface RemoteHookCommand {
  event: HookEvent;
  /** The local spec file: its input schema shapes the state, its name is the set slug. */
  setPath: string;
  /** The set slug on the server, when it differs from the spec file name. */
  remoteSet?: string;
  timeoutMs: number;
  receiptsPath: string;
  drop: string[];
}

export interface RemoteHookDeps {
  stdin: () => Promise<string>;
  remote: Remote;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchFn;
  now?: () => number;
  newId?: () => string;
  writeReceipt?: (path: string, receipt: Receipt) => void;
  readTranscript?: (path: string) => string;
}

/** The provider on remote receipts: the server picks the System One provider, not this machine. */
export const REMOTE_PROVIDER = "bandwise";

/** Enough of a RunResult to answer the hook and write a receipt. */
function looksLikeRunResult(x: unknown): x is RunResult {
  if (!isObj(x) || !isObj(x["decisions"]) || !isObj(x["cost"])) return false;
  const c = x["cost"];
  return (
    typeof x["status"] === "string" &&
    typeof x["rollout"] === "string" &&
    typeof x["overallAction"] === "string" &&
    (typeof x["route"] === "string" || x["route"] === null) &&
    typeof c["counterfactualLlmCostUsd"] === "number" &&
    typeof c["latencyMs"] === "number"
  );
}

/** Only controlled and full may act. Anything else, paused included, reads as shadow. */
const actingRollout = (stage: string): HookRollout => (stage === "controlled" || stage === "full" ? stage : "shadow");

/** Run one hosted hook call. Never throws and never exits non-zero. */
export async function runRemoteHook(cmd: RemoteHookCommand, deps: RemoteHookDeps): Promise<HookOutput> {
  const now = deps.now ?? Date.now;
  const started = now();
  const host = new URL(deps.remote.baseUrl).host;
  let meta: { set: string; specHash: string; modelRequested: string } | null = null;
  let session: ReceiptSession | undefined;
  const withExtras = (r: Receipt, remote: Receipt["remote"]): Receipt => ({ ...r, ...(session !== undefined ? { session } : {}), remote });
  const failed = (status: string): Receipt | null => {
    if (meta === null) return null;
    const r = failureReceipt({ ...meta, source: cmd.event, provider: REMOTE_PROVIDER, at: new Date(now()).toISOString(), acted: false, rollout: "unknown", status, latencyMs: now() - started });
    return withExtras(r, { host, version: null, channel: null, runId: null });
  };
  const guard = { timeoutMs: cmd.timeoutMs, receiptsPath: cmd.receiptsPath, ...(deps.writeReceipt !== undefined ? { writeReceipt: deps.writeReceipt } : {}) };

  return guardHook(
    guard,
    async ({ signal, record }) => {
      const spec: unknown = JSON.parse(readFileSync(cmd.setPath, "utf8"));
      if (!isObj(spec)) return SILENT;
      const input = isObj(spec["input"]) ? spec["input"] : {};
      meta = {
        set: cmd.remoteSet ?? basename(cmd.setPath).replace(/\.spec\.json$|\.json$/, ""),
        // The same hash live mode records for this file.
        specHash: fnv1a64(JSON.stringify(spec)),
        modelRequested: typeof spec["model"] === "string" ? spec["model"] : "unknown",
      };
      const prepared = prepareHook(cmd.event, await deps.stdin(), input["schema"], cmd.drop, {
        started,
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.readTranscript !== undefined ? { readTranscript: deps.readTranscript } : {}),
      });
      if (prepared.kind === "skip") return SILENT;
      session = prepared.session;

      const client = createClient(deps.remote, { ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}), ...(deps.newId !== undefined ? { newId: deps.newId } : {}) });
      // No retries: the hook's own timeout is the whole budget.
      const res = await client.request("POST", path`/sets/${meta.set}/run`, { body: { state: prepared.state }, signal, retry: false });
      if (!res.ok || !looksLikeRunResult(res.body)) {
        const r = failed(res.ok ? "bad_response" : res.error.code);
        if (r !== null) record(r);
        return SILENT;
      }
      const result = res.body;
      const response = hookResponse(cmd.event, actingRollout(result.rollout), result);
      const receipt = receiptFromResult(result, { ...meta, source: cmd.event, provider: REMOTE_PROVIDER, at: new Date(now()).toISOString(), acted: response !== null });
      record(withExtras(receipt, { host, version: typeof result.version === "number" ? result.version : null, channel: typeof result.channel === "string" ? result.channel : null, runId: typeof result.runId === "string" ? result.runId : null }));
      return response === null ? SILENT : { exitCode: 0, stdout: JSON.stringify(response) };
    },
    () => failed("timeout"),
  );
}
