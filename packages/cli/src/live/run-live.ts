// `bandwise run --live spec.json state.json [--provider typesafe|openrouter|vercel]`: the same run
// as local mode, answered by the real System One model with the developer's own key.

import { basename } from "node:path";
import { type RolloutStage, type RunResult, type SystemOneProvider, type SystemOneTransport, staticKeyResolver } from "@bandwise/core";
import { type Receipt, specHash } from "../receipts/index.js";
import { type LoadedSpec, type Refusal, basePorts, loadSpec, readJsonFile, runSpec } from "../runner/index.js";
import { readProviderKey } from "./key.js";
import { receiptFromResult } from "./receipt-from-result.js";

/** The set slug for a spec path: the file name without `.spec.json` or `.json`. */
export function setSlug(specPath: string): string {
  return basename(specPath).replace(/\.spec\.json$|\.json$/, "");
}

export interface LiveDeps {
  env?: Readonly<Record<string, string | undefined>>;
  transport: SystemOneTransport;
  now?: () => number;
  newId?: () => string;
}

export interface LiveRunOptions {
  spec: LoadedSpec;
  set: string;
  state: unknown;
  provider?: SystemOneProvider;
  rollout?: RolloutStage;
  channel?: "production" | "staging";
  source?: string;
  signal?: AbortSignal;
}

export type LiveRunOutcome = { ok: true; result: RunResult; receipt: (acted: boolean) => Receipt } | Refusal;

const randomId = (): string => globalThis.crypto.randomUUID();

/** Run a loaded spec live. A missing key is a refusal that names the variable. */
export async function runLiveSpec(o: LiveRunOptions, deps: LiveDeps): Promise<LiveRunOutcome> {
  const provider = o.provider ?? "typesafe";
  const key = readProviderKey(provider, deps.env);
  if (!key.ok) return { ok: false, code: "system_one_key_missing", message: key.message, details: [] };
  const now = deps.now ?? Date.now;
  const ports = basePorts(deps.transport, staticKeyResolver({ [provider]: key.apiKey }), now, deps.newId ?? randomId);
  const run: Parameters<typeof runSpec>[0] = { spec: o.spec.spec, state: o.state, ports, provider };
  if (o.rollout !== undefined) run.rollout = o.rollout;
  if (o.channel !== undefined) run.channel = o.channel;
  if (o.signal !== undefined) run.signal = o.signal;
  const outcome = await runSpec(run);
  if (!outcome.ok) return outcome;
  const hash = specHash(o.spec.text);
  const at = new Date(now()).toISOString();
  return {
    ok: true,
    result: outcome.result,
    receipt: (acted) => receiptFromResult(outcome.result, { set: o.set, specHash: hash, source: o.source ?? "run", provider, at, acted }),
  };
}

export interface LiveFileOptions {
  specPath: string;
  statePath: string;
  provider?: SystemOneProvider;
  rollout?: RolloutStage;
  channel?: "production" | "staging";
}

/** Read the spec and state files and run them live. */
export async function runLive(o: LiveFileOptions, deps: LiveDeps): Promise<LiveRunOutcome> {
  const spec = loadSpec(o.specPath);
  if (!spec.ok) return spec;
  const state = readJsonFile(o.statePath, "state");
  if (!state.ok) return state;
  const run: LiveRunOptions = { spec: spec.value, set: setSlug(o.specPath), state: state.value };
  if (o.provider !== undefined) run.provider = o.provider;
  if (o.rollout !== undefined) run.rollout = o.rollout;
  if (o.channel !== undefined) run.channel = o.channel;
  return runLiveSpec(run, deps);
}
