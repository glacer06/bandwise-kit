// The run shared by `bandwise run --local` and `bandwise run --live` (and `bandwise hook`): read a
// spec, validate it, and run it through core's run engine on the ports the caller built. This
// folder imports core only. It never picks a transport: local mode passes the fixture transport,
// live mode the SDK transport.

import { readFileSync } from "node:fs";
import {
  type LintResult,
  type QuestionSetSpec,
  type RolloutStage,
  type RunPorts,
  type RunResult,
  type SystemOneProvider,
  type TenantContext,
  SEED_MODEL_PROFILES,
  isRunRefusedError,
  latencyBudgetMs,
  lint,
  parseSpec,
  runQuestionSet,
} from "@bandwise/core";

/** The org every CLI run belongs to. Nothing is stored in any database. */
export const CLI_ORG_ID = "00000000-0000-7000-8000-00000000c0de";

export const CLI_CONTEXT: TenantContext = {
  orgId: CLI_ORG_ID,
  actor: { type: "user", userId: "00000000-0000-7000-8000-00000000c0df", role: "owner", platformRole: null, impersonatorId: null },
  client: "cli",
  plan: "local",
  requestId: "local",
};

export type Refusal = { ok: false; code: string; message: string; details: LintResult[] };

export type ReadResult<T> = { ok: true; value: T } | Refusal;

/** Read a JSON file. Never throws; the refusal says what went wrong. */
export function readJsonFile(path: string, what: string): ReadResult<unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, code: "invalid_request", message: `cannot read the ${what} file ${path}`, details: [] };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: "invalid_request", message: `the ${what} file ${path} is not valid JSON`, details: [] };
  }
}

export interface LoadedSpec {
  spec: QuestionSetSpec;
  /** The spec file's text, for the receipt's spec hash. */
  text: string;
}

/** Read and validate a spec file. */
export function loadSpec(path: string): ReadResult<LoadedSpec> {
  const json = readJsonFile(path, "spec");
  if (!json.ok) return json;
  const parsed = parseSpec(json.value);
  if (!parsed.ok) return { ok: false, code: "spec_invalid", message: "the spec does not validate", details: parsed.details };
  return { ok: true, value: { spec: parsed.spec, text: JSON.stringify(json.value) } };
}

export interface RunSpecOptions {
  spec: QuestionSetSpec;
  state: unknown;
  ports: RunPorts;
  provider?: SystemOneProvider;
  rollout?: RolloutStage;
  channel?: "production" | "staging";
  signal?: AbortSignal;
}

export type RunSpecOutcome = { ok: true; result: RunResult; lint: LintResult[] } | Refusal;

/** Run a validated spec on a state. A refused run (bad state, paused) comes back as a refusal. */
export async function runSpec(o: RunSpecOptions): Promise<RunSpecOutcome> {
  const profile = SEED_MODEL_PROFILES.find((p) => p.id === o.spec.model) ?? null;
  const lints = lint(o.spec, profile);
  try {
    const result = await runQuestionSet(
      CLI_CONTEXT,
      { setRef: "local", state: o.state, source: "cli", options: {} },
      {
        spec: o.spec,
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
          systemOneProvider: o.provider ?? "typesafe",
        },
      },
      o.ports,
      { signal: o.signal ?? new AbortController().signal, budgetMs: latencyBudgetMs("cli") },
    );
    return { ok: true, result, lint: lints };
  } catch (e) {
    if (isRunRefusedError(e)) return { ok: false, code: e.code, message: e.message, details: e.details ?? [] };
    throw e;
  }
}
