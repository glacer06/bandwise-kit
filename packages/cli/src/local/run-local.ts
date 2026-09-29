// `bandwise run --local spec.json state.json`: run a spec file on a state file with core and the
// fixture transport. It makes no network call
// and needs no key. Recorded fixtures answer the requests they cover; anything else gets
// deterministic synthetic answers, and the output says so.

import type { LintResult, RolloutStage, RunResult, SystemOneProvider } from "@bandwise/core";
import { loadSpec, readJsonFile, runSpec } from "../runner/index.js";
import { localPorts } from "./ports.js";

export interface LocalRunOptions {
  specPath: string;
  statePath: string;
  provider?: SystemOneProvider;
  rollout?: RolloutStage;
  channel?: "production" | "staging";
  /** Epoch ms clock and run id source. Defaults: Date.now and crypto.randomUUID. */
  now?: () => number;
  newId?: () => string;
}

export type LocalRunOutcome =
  | { ok: true; result: RunResult; lint: LintResult[]; answersFrom: Array<"fixture" | "synthetic"> }
  | { ok: false; code: string; message: string; details: LintResult[] };

const randomId = (): string => globalThis.crypto.randomUUID();

/** Run a spec on a state locally. Never throws for bad input; the outcome says what went wrong. */
export async function runLocal(o: LocalRunOptions): Promise<LocalRunOutcome> {
  const loaded = loadSpec(o.specPath);
  if (!loaded.ok) return loaded;
  const state = readJsonFile(o.statePath, "state");
  if (!state.ok) return state;
  const { ports, transport } = localPorts(o.now ?? Date.now, o.newId ?? randomId);
  const run: Parameters<typeof runSpec>[0] = { spec: loaded.value.spec, state: state.value, ports };
  if (o.provider !== undefined) run.provider = o.provider;
  if (o.rollout !== undefined) run.rollout = o.rollout;
  if (o.channel !== undefined) run.channel = o.channel;
  const outcome = await runSpec(run);
  if (!outcome.ok) return outcome;
  return { ...outcome, answersFrom: transport.calls.map((c) => (c.fixture === null ? "synthetic" : "fixture")) };
}
