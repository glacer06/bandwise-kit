// `bandwise run --local spec.json state.json`: run a spec file on a state file with core and the
// fixture transport. It makes no network call
// and needs no key. Recorded fixtures answer the requests they cover; anything else gets
// deterministic synthetic answers, and the output says so.

import { readFileSync } from "node:fs";
import {
  type LintResult,
  type RolloutStage,
  type RunResult,
  type SystemOneProvider,
  SEED_MODEL_PROFILES,
  isRunRefusedError,
  latencyBudgetMs,
  lint,
  parseSpec,
  runQuestionSet,
} from "@bandwise/core";
import { LOCAL_CONTEXT, localPorts } from "./ports.js";

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

function readJson(path: string, what: string): { ok: true; value: unknown } | { ok: false; message: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: `cannot read the ${what} file ${path}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: `the ${what} file ${path} is not valid JSON` };
  }
}

const randomId = (): string => globalThis.crypto.randomUUID();

/** Run a spec on a state locally. Never throws for bad input; the outcome says what went wrong. */
export async function runLocal(o: LocalRunOptions): Promise<LocalRunOutcome> {
  const specJson = readJson(o.specPath, "spec");
  if (!specJson.ok) return { ok: false, code: "invalid_request", message: specJson.message, details: [] };
  const stateJson = readJson(o.statePath, "state");
  if (!stateJson.ok) return { ok: false, code: "invalid_request", message: stateJson.message, details: [] };
  const parsed = parseSpec(specJson.value);
  if (!parsed.ok) return { ok: false, code: "spec_invalid", message: "the spec does not validate", details: parsed.details };
  const spec = parsed.spec;

  const provider = o.provider ?? "typesafe";
  const now = o.now ?? Date.now;
  const newId = o.newId ?? randomId;
  const { ports, transport } = localPorts(now, newId);
  const profile = SEED_MODEL_PROFILES.find((p) => p.id === spec.model) ?? null;
  const lints = lint(spec, profile);

  try {
    const result = await runQuestionSet(
      LOCAL_CONTEXT,
      { setRef: "local", state: stateJson.value, source: "cli", options: {} },
      {
        spec,
        setId: "00000000-0000-7000-8000-0000000005e7",
        version: 1,
        versionId: "00000000-0000-7000-8000-0000000005e8",
        interfaceMajor: 1,
        interfaceHash: "local",
        channel: o.channel ?? "production",
        rollout: o.rollout ?? "full",
        settings: {
          dispatchActionsOnStaging: false,
          storageMode: "full",
          piiMode: "off",
          defaultComparatorModel: "claude-haiku-4-5",
          avgEscalationCostMicroUsd: null,
          systemOneProvider: provider,
        },
      },
      ports,
      { signal: new AbortController().signal, budgetMs: latencyBudgetMs("cli") },
    );
    return { ok: true, result, lint: lints, answersFrom: transport.calls.map((c) => (c.fixture === null ? "synthetic" : "fixture")) };
  } catch (e) {
    if (isRunRefusedError(e)) return { ok: false, code: e.code, message: e.message, details: e.details ?? [] };
    throw e;
  }
}
