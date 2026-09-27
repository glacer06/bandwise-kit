// Test harness for the run engine: a scripted System One transport, in-memory ports, contexts and
// resolved runs. Tests only; excluded from the build.

import { readFileSync } from "node:fs";
import type { RunSettings, ResolvedRun, RunPorts, SystemOneCallOptions, SystemOneTransport } from "../contracts/ports.js";
import { TransportError } from "../contracts/ports.js";
import type { QuestionSetSpec, RunRequest } from "../contracts/spec.js";
import { parseSpec } from "../contracts/spec.js";
import type { SystemOneRequest, SystemOneResponse } from "../contracts/system-one.js";
import type { TenantContext } from "../contracts/tenant.js";
import type { Role } from "../contracts/common.js";
import {
  SEED_COMPARATOR_PRICES,
  SEED_MODEL_PROFILES,
  SEED_MODEL_ROUTES,
  SEED_SYSTEM_ONE_PRICES,
} from "../models/catalog.js";
import {
  allowAllLimiter,
  allowAllQuota,
  createMemoryActionRegistry,
  createMemoryModelCatalog,
  createMemoryPriceBook,
  createMemoryRunSink,
  sequentialIds,
  staticKeyResolver,
  steppingClock,
} from "../memory/ports.js";

export const ORG_ID = "01890000-0000-7000-8000-00000000000a";
export const OTHER_ORG_ID = "01890000-0000-7000-8000-00000000000b";
export const SET_ID = "01890000-0000-7000-8000-0000000000a1";
export const VERSION_ID = "01890000-0000-7000-8000-0000000000b1";

const examplePath = new URL("../../../../examples/email-triage.spec.json", import.meta.url);

/** The skill's example spec, parsed. */
export function exampleSpec(): QuestionSetSpec {
  const parsed = parseSpec(JSON.parse(readFileSync(examplePath, "utf8")));
  if (!parsed.ok) throw new Error("the example spec does not parse");
  return parsed.spec;
}

/** A state that fits the example spec. */
export function exampleState(): Record<string, unknown> {
  return {
    email: { from: "ana@example.com", subject: "Re: contract", body: "Can you approve the contract by Friday?", signature: "Ana, +1 555 0100" },
    me: { name: "Sam", known_contacts: ["ana@example.com"] },
  };
}

export function userCtx(role: Role = "owner"): TenantContext {
  return {
    orgId: ORG_ID,
    actor: { type: "user", userId: "01890000-0000-7000-8000-0000000000c1", role, platformRole: null, impersonatorId: null },
    client: "console",
    plan: "pro",
    requestId: "req_test",
  };
}

export const DEFAULT_SETTINGS: RunSettings = {
  dispatchActionsOnStaging: false,
  storageMode: "full",
  piiMode: "off",
  defaultComparatorModel: "claude-haiku-4-5",
  avgEscalationCostMicroUsd: null,
  systemOneProvider: "typesafe",
};

export function resolvedRun(
  spec: QuestionSetSpec,
  over: Omit<Partial<ResolvedRun>, "settings"> & { settings?: Partial<RunSettings> } = {},
): ResolvedRun {
  const { settings, ...rest } = over;
  return {
    spec,
    setId: SET_ID,
    version: 3,
    versionId: VERSION_ID,
    interfaceMajor: 1,
    interfaceHash: "ifh_test",
    channel: "production",
    rollout: "full",
    ...rest,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

export function runRequest(state: unknown, over: Partial<RunRequest> = {}): RunRequest {
  return { setRef: "email-triage", state, source: "api", options: {}, ...over };
}

/** An AbortSignal-shaped value that never fires. */
export const neverAborted = { aborted: false } as AbortSignal;

export function control(budgetMs = 8_000, signal: AbortSignal = neverAborted) {
  return { signal, budgetMs };
}

/** A transport whose answers come from a function of the request. Records every call. */
export interface ScriptedTransport extends SystemOneTransport {
  readonly calls: Array<{ req: SystemOneRequest; opts: SystemOneCallOptions }>;
}

export type Responder = (req: SystemOneRequest, n: number) => SystemOneResponse | Error;

export function scriptedTransport(responder: Responder, requestId: (n: number) => string | null = (n) => `req_${n}`): ScriptedTransport {
  const calls: ScriptedTransport["calls"] = [];
  return {
    calls,
    async call(req, opts) {
      calls.push({ req, opts });
      const out = responder(req, calls.length);
      if (out instanceof Error) throw out;
      return { response: out, requestId: requestId(calls.length) };
    },
  };
}

export const transportError = (code: TransportError["code"], retryable = false): TransportError =>
  new TransportError({ code, retryable, requestId: "req_err" }, "scrubbed");

/** Answers for the example spec's questions, keyed by id. Missing ids get a default by type. */
export type AnswerMap = Record<string, Record<string, unknown>>;

export const EXAMPLE_ANSWERS: AnswerMap = {
  real_person: { type: "noul", noul: 0.97 },
  someone_waiting: { type: "noul", noul: 0.9 },
  cost_of_ignoring: {
    type: "score",
    score: 2.2,
    confidence: 0.8,
    legend: { "0": "Nothing", "1": "Minor", "2": "Real", "3": "Severe" },
    probabilities: { "0": 0.02, "1": 0.08, "2": 0.58, "3": 0.32 },
  },
  category: {
    type: "choice",
    choice: "work_request",
    confidence: 0.82,
    probabilities: { work_request: 0.88, scheduling: 0.04, personal: 0.02, newsletter: 0.01, transactional: 0.01, none_of_these: 0.04 },
  },
  work_type: {
    type: "choice",
    choice: "decision",
    confidence: 0.79,
    probabilities: { decision: 0.86, information: 0.08, review: 0.04, none_of_these: 0.02 },
  },
};

/** A responder that answers every question in the request from a map. */
export function answersFrom(map: AnswerMap, model = "jev-1.13.0", usage = { input_tokens: 318, output_tokens: 34 }): Responder {
  return (req) => {
    const answers: Record<string, unknown> = {};
    for (const qid of Object.keys(req.questions)) {
      const a = map[qid];
      if (a !== undefined) answers[qid] = a;
    }
    return { model, answers, usage } as SystemOneResponse;
  };
}

export interface HarnessOptions {
  transport?: SystemOneTransport;
  keys?: RunPorts["keys"];
  llm?: RunPorts["llm"];
  linkedRun?: RunPorts["linkedRun"];
  limiter?: RunPorts["limiter"];
  quota?: RunPorts["quota"];
  enabledHandlers?: string[];
  prices?: RunPorts["prices"];
  models?: RunPorts["models"];
  redactor?: RunPorts["redactor"];
  clock?: RunPorts["clock"];
}

/** In-memory ports around a transport. Returns the sink and the action registry for assertions. */
export function makePorts(o: HarnessOptions = {}) {
  const ids = sequentialIds();
  const runs = createMemoryRunSink(sequentialIds("00000000-0000-7000-9000-"));
  const actions = createMemoryActionRegistry(o.enabledHandlers ?? []);
  const transport = o.transport ?? scriptedTransport(answersFrom(EXAMPLE_ANSWERS));
  const ports: RunPorts = {
    systemOne: transport,
    models: o.models ?? createMemoryModelCatalog(SEED_MODEL_PROFILES, SEED_MODEL_ROUTES),
    keys: o.keys ?? staticKeyResolver({ typesafe: "ts_test_key", openrouter: "or_test_key", vercel: "vg_test_key" }),
    limiter: o.limiter ?? allowAllLimiter,
    quota: o.quota ?? allowAllQuota,
    runs,
    actions,
    prices: o.prices ?? createMemoryPriceBook([...SEED_SYSTEM_ONE_PRICES, ...SEED_COMPARATOR_PRICES]),
    clock: o.clock ?? steppingClock(),
    newId: ids,
  };
  if (o.llm !== undefined) ports.llm = o.llm;
  if (o.linkedRun !== undefined) ports.linkedRun = o.linkedRun;
  if (o.redactor !== undefined) ports.redactor = o.redactor;
  return { ports, runs, actions, transport };
}
