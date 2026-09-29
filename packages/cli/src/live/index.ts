// Live mode of @bandwise/cli: `bandwise run --live` and `bandwise hook`. The only CLI
// folder that may import @bandwise/system-one-client, and only through transport.ts. main.ts loads
// it with a dynamic import, so local mode and `bandwise report` never load the SDK.

import type { RolloutStage, SystemOneProvider } from "@bandwise/core";
import type { CommandOutput } from "../main.js";
import { appendReceipt } from "../receipts/index.js";
import { formatLiveRun } from "./format.js";
import { type HookCommand, type HookDeps, runHook } from "./hook.js";
import { runLive } from "./run-live.js";
import { type LiveFetch, liveTransport } from "./transport.js";

export { DEFAULT_HOOK_TIMEOUT_MS, GATED_TOOLS, HOOK_EVENTS, HOOK_ROLLOUTS, type HookCommand, type HookEvent, type HookRollout, hookResponse, isTrustedCommand, lastExchange, mapHookInput, runHook } from "./hook.js";
export { PROVIDER_KEY_ENV, readProviderKey } from "./key.js";
export { redactSecrets, shapeState } from "./redact.js";
export { runLive, runLiveSpec, setSlug } from "./run-live.js";

export interface LiveCommand {
  specPath: string;
  statePath: string;
  json: boolean;
  provider?: SystemOneProvider;
  rollout?: RolloutStage;
  channel?: "production" | "staging";
  /** Append a receipt here when set. */
  receiptsPath?: string;
}

export interface LiveIo {
  env?: Readonly<Record<string, string | undefined>>;
  /** Tests pass a fetch so no request leaves the process. */
  fetch?: LiveFetch;
}

/** `bandwise run --live`. Exit 0 on an ok run, 1 otherwise. */
export async function runLiveCommand(cmd: LiveCommand, io: LiveIo = {}): Promise<CommandOutput> {
  const opts: Parameters<typeof runLive>[0] = { specPath: cmd.specPath, statePath: cmd.statePath };
  if (cmd.provider !== undefined) opts.provider = cmd.provider;
  if (cmd.rollout !== undefined) opts.rollout = cmd.rollout;
  if (cmd.channel !== undefined) opts.channel = cmd.channel;
  const deps: Parameters<typeof runLive>[1] = { transport: liveTransport(io.fetch !== undefined ? { fetch: io.fetch } : {}) };
  if (io.env !== undefined) deps.env = io.env;
  const outcome = await runLive(opts, deps);
  if (!outcome.ok) {
    const body = { error: { code: outcome.code, message: outcome.message, details: outcome.details } };
    const text = cmd.json
      ? JSON.stringify(body, null, 2)
      : [`error ${outcome.code}: ${outcome.message}`, ...outcome.details.map((d) => `  ${d.rule} at ${d.path || "/"}: ${d.message}`)].join("\n");
    return { exitCode: 1, stdout: cmd.json ? text : "", stderr: cmd.json ? "" : text };
  }
  let note = "";
  if (cmd.receiptsPath !== undefined) {
    try {
      appendReceipt(cmd.receiptsPath, outcome.receipt(false));
      note = `receipt appended to ${cmd.receiptsPath}`;
    } catch (e) {
      note = `could not write the receipt to ${cmd.receiptsPath}: ${(e as Error).message}`;
    }
  }
  const exitCode = outcome.result.status === "ok" ? 0 : 1;
  if (cmd.json) return { exitCode, stdout: JSON.stringify(outcome.result, null, 2), stderr: note };
  return { exitCode, stdout: formatLiveRun(outcome.result, note), stderr: "" };
}

/** `bandwise hook`. Always exit 0; stdout is hook JSON or nothing. */
export async function runHookCommand(cmd: HookCommand, io: Omit<HookDeps, "transport"> & Pick<LiveIo, "fetch">): Promise<CommandOutput> {
  const { fetch, ...rest } = io;
  const out = await runHook(cmd, { ...rest, transport: () => liveTransport(fetch !== undefined ? { fetch } : {}) });
  return { exitCode: out.exitCode, stdout: out.stdout, stderr: "" };
}
