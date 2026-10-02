// `bandwise hook <event> --set <path>`: a Claude Code hook backed by a question set.
//
// It reads Claude Code's hook JSON on stdin, maps it to the fields the set's input schema names
// (redacted and cut to maxLength), runs the set live, appends a receipt, and prints hook JSON only
// when the set may act. In `shadow` it never blocks, denies or adds context. In `controlled` only a
// high band answer acts (core's effective action). Any error or a timeout (3 seconds by default)
// ends with exit 0 and no output, so a hook never breaks a session.
// With BANDWISE_TOKEN set, main.ts runs hook-remote.ts instead, against the hosted endpoint.

import type { SystemOneProvider, SystemOneTransport } from "@bandwise/core";
import { type Receipt, type ReceiptSession, specHash } from "../receipts/index.js";
import { loadSpec } from "../runner/index.js";
import { type HookEvent, type HookOutput, type HookRollout, SILENT, guardHook, hookResponse, prepareHook } from "./hook-input.js";
import { readProviderKey } from "./key.js";
import { failureReceipt } from "./receipt-from-result.js";
import { runLiveSpec, setSlug } from "./run-live.js";

export {
  DEFAULT_HOOK_TIMEOUT_MS,
  GATED_TOOLS,
  HOOK_EVENTS,
  HOOK_ROLLOUTS,
  type HookEvent,
  type HookOutput,
  type HookRollout,
  type TaskStats,
  hookResponse,
  isTrustedCommand,
  lastExchange,
  mapHookInput,
  taskStats,
} from "./hook-input.js";

export interface HookCommand {
  event: HookEvent;
  setPath: string;
  rollout: HookRollout;
  provider: SystemOneProvider;
  timeoutMs: number;
  receiptsPath: string;
  /** Input fields never to send, on top of the schema filter. */
  drop: string[];
}

export interface HookDeps {
  stdin: () => Promise<string>;
  env?: Readonly<Record<string, string | undefined>>;
  transport: () => SystemOneTransport;
  now?: () => number;
  /** Tests replace the receipt writer. */
  writeReceipt?: (path: string, receipt: Receipt) => void;
  /** Tests replace the transcript reader. */
  readTranscript?: (path: string) => string;
}

/** Run one hook call. Never throws and never exits non-zero. */
export async function runHook(cmd: HookCommand, deps: HookDeps): Promise<HookOutput> {
  const now = deps.now ?? Date.now;
  const started = now();
  let meta: { set: string; specHash: string; modelRequested: string } | null = null;
  let session: ReceiptSession | undefined;
  const failed = (status: string): Receipt | null => {
    if (meta === null) return null;
    const r = failureReceipt({ ...meta, source: cmd.event, provider: cmd.provider, at: new Date(now()).toISOString(), acted: false, rollout: cmd.rollout, status, latencyMs: now() - started });
    return session === undefined ? r : { ...r, session };
  };
  const guard = { timeoutMs: cmd.timeoutMs, receiptsPath: cmd.receiptsPath, ...(deps.writeReceipt !== undefined ? { writeReceipt: deps.writeReceipt } : {}) };

  return guardHook(
    guard,
    async ({ signal, record }) => {
      // No key, no call and no receipt: the hook is simply off.
      if (!readProviderKey(cmd.provider, deps.env).ok) return SILENT;
      const loaded = loadSpec(cmd.setPath);
      if (!loaded.ok) return SILENT;
      meta = { set: setSlug(cmd.setPath), specHash: specHash(loaded.value.text), modelRequested: loaded.value.spec.model };
      const prepared = prepareHook(cmd.event, await deps.stdin(), loaded.value.spec.input.schema, cmd.drop, {
        started,
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.readTranscript !== undefined ? { readTranscript: deps.readTranscript } : {}),
      });
      if (prepared.kind === "skip") return SILENT;
      session = prepared.session;
      const outcome = await runLiveSpec(
        { spec: loaded.value, set: meta.set, state: prepared.state, provider: cmd.provider, rollout: cmd.rollout, source: cmd.event, signal },
        { ...(deps.env !== undefined ? { env: deps.env } : {}), transport: deps.transport(), now },
      );
      if (!outcome.ok) {
        const r = failed(outcome.code);
        if (r !== null) record(r);
        return SILENT;
      }
      const response = hookResponse(cmd.event, cmd.rollout, outcome.result);
      const receipt = outcome.receipt(response !== null);
      record(session === undefined ? receipt : { ...receipt, session });
      return response === null ? SILENT : { exitCode: 0, stdout: JSON.stringify(response) };
    },
    () => failed("timeout"),
  );
}
