// runQuestionSet: one run, wired through RunPorts.
//
// Pure: every clock read, id, key, call and write goes through a port. The function returns a
// RunResult for every run that got a run id, including failed ones, and throws RunRefusedError
// only before a run row exists.

import type { Action, ErrorCode, QuestionId, RunDryRunResult } from "../contracts/index.js";
import { microFromUsd, responseCostMicroUsd, usdFromMicro } from "../contracts/run.js";
import type { Decision, RunCall, RunCost, RunResult, RunStage } from "../contracts/run.js";
import type { EffectiveModel, ModelPrice, RunControl, RunPorts } from "../contracts/ports.js";
import { isTransportError } from "../contracts/ports.js";
import type { ModelLimits, ModelRoute } from "../contracts/models.js";
import { registryIdForResolved } from "../contracts/models.js";
import type { ResolvedRun } from "../contracts/ports.js";
import type { QuestionSetSpec, RunRequest } from "../contracts/spec.js";
import type { SystemOneAnswer, SystemOneProvider, SystemOneResponse } from "../contracts/system-one.js";
import type { TenantContext } from "../contracts/tenant.js";
import type { QuestionView } from "../conditions/evaluate.js";
import { hashJson } from "../util/canonical-json.js";
import { validateJsonSchema } from "../util/json-schema.js";
import { readAnswer } from "./answers.js";
import { callBudget } from "./budget.js";
import { compileStageQuestions } from "./compiler.js";
import { type CountedQuestion, callCostMicro, computeSavings, savingsSuppression, sumCostMicro } from "./cost.js";
import { routingStage } from "./effective-action.js";
import { RunRefusedError, runErrorMessage } from "./errors.js";
import { buildEscalationRequest, escalationModel, parseEscalationReply } from "./escalation.js";
import { type PreflightBatch, preflightStage } from "./preflight.js";
import { type DecisionMeta, escalationConfigOf, fallbackConfigOf, routeAnswers, routeOutage, summarizeDecisions } from "./router.js";
import { evaluateChecks, redactPathsDefault, stageRuns, stageState, whenReadsAnswers } from "./stages.js";

/** Run warnings core adds itself (answer warnings live in answers.ts, preflight ones in preflight.ts). */
export const RUN_WARNINGS = {
  modelUnpriced: "model_unpriced",
  modelResolvedMixed: "model_resolved_mixed",
  modelResolvedUnmapped: "model_resolved_unmapped",
  escalationFailed: "escalation_failed",
  escalationUnpriced: "escalation_unpriced",
  fallbackSetFailed: "fallback_set_failed",
  comparatorUnpriced: "comparator_unpriced",
  adapterNotApplied: "input_adapter_not_applied",
  handlerDisabled: "action_handler_disabled",
  dryRunAnswersUnknown: "dry_run_answers_unknown",
  systemOneOutage: "system_one_outage",
} as const;

/**
 * The failure codes the outage rule covers: System One unavailable or overloaded after
 * SDK retries, including an exhausted latency budget. The run still returns decisions, each with
 * the set's onUnavailable action.
 */
export const OUTAGE_ERROR_CODES: readonly ErrorCode[] = ["system_one_unavailable", "system_one_overloaded"];

/** True when a failed run's code is an outage. */
export function isOutageCode(code: ErrorCode): boolean {
  return OUTAGE_ERROR_CODES.includes(code);
}

/**
 * True for a run that ended in an outage (warning system_one_outage). Outage runs book no savings
 * and are left out of calibration, precision and coverage metrics.
 */
export function isOutageRun(result: Pick<RunResult, "status" | "warnings">): boolean {
  return result.status === "error" && result.warnings.includes(RUN_WARNINGS.systemOneOutage);
}

/** Default spec.savings.estOutputTokensPerQuestion. */
export const DEFAULT_EST_OUTPUT_TOKENS_PER_QUESTION = 60;

// ---------------------------------------------------------------------------
// Preparation: steps 1, 3, 4, 5 and 6. Throws RunRefusedError; writes nothing.

interface Prepared {
  spec: QuestionSetSpec;
  input: unknown;
  sentInput: unknown;
  checks: Record<string, boolean>;
  effective: EffectiveModel & { providerModelId: string; limits: ModelLimits };
  provider: SystemOneProvider;
  routes: ModelRoute[];
  warnings: string[];
  /** First-pass preflight per spec stage on input only: skipped, or its batches. */
  plan: Array<{ id: string; skipped: boolean; batches: PreflightBatch[] }>;
}

async function prepare(req: RunRequest, resolved: ResolvedRun, ports: RunPorts): Promise<Prepared> {
  const { spec, settings } = resolved;
  if (routingStage(resolved.rollout, resolved.channel) === "inactive") {
    throw new RunRefusedError("set_not_live", "The set is not live on this channel.");
  }
  if (req.interfaceMajor !== undefined && req.interfaceMajor !== resolved.interfaceMajor) {
    throw new RunRefusedError(
      "interface_mismatch",
      `The caller expects interface major ${req.interfaceMajor}; the version serves ${resolved.interfaceMajor}.`,
    );
  }
  const issues = validateJsonSchema(spec.input.schema, req.state);
  if (issues.length > 0) {
    throw new RunRefusedError(
      "invalid_state",
      "The state does not match the set's input schema.",
      issues.map((i) => ({ path: i.path, rule: "state.invalid", severity: "error" as const, message: i.message })),
    );
  }
  const warnings: string[] = [];
  // Input adapters are plugins (Phase 5). Until then the state is used as sent.
  if (spec.input.adapter !== undefined) warnings.push(RUN_WARNINGS.adapterNotApplied);

  const input = req.state;
  const checks = evaluateChecks(spec.checks, input);
  const paths = spec.input.redactPaths ?? [];
  const sentInput = ports.redactor ? ports.redactor(input, paths, settings.piiMode) : redactPathsDefault(input, paths);

  const provider = settings.systemOneProvider;
  const eff = await ports.models.effective(spec.model, provider);
  const status = eff.profile?.status;
  const usable =
    eff.profile !== null &&
    eff.providerModelId !== null &&
    eff.limits !== null &&
    status !== "retired" &&
    (status !== "unreviewed" || req.source === "playground");
  if (!usable) throw new RunRefusedError("model_unavailable", `The model ${spec.model} is not available on ${provider}.`);
  const effective = eff as Prepared["effective"];
  const routes = await ports.models.routes(provider);

  const plan: Prepared["plan"] = [];
  for (const stage of spec.stages) {
    const decidable = !whenReadsAnswers(stage);
    const skipped = decidable && !stageRuns(stage, { input, checks, questions: {}, composites: {} });
    if (skipped) {
      plan.push({ id: stage.id, skipped, batches: [] });
      continue;
    }
    const state = stageState(stage, sentInput, {}, {});
    const pf = preflightStage(compileStageQuestions(stage), state, effective.providerModelId, effective.limits, spec.input.maxStateTokens);
    if (!pf.ok) throw new RunRefusedError("preflight_too_large", `Stage ${stage.id}: ${pf.message}.`);
    for (const w of pf.warnings) if (!warnings.includes(w)) warnings.push(w);
    plan.push({ id: stage.id, skipped, batches: pf.batches });
  }
  return { spec, input, sentInput, checks, effective, provider, routes, warnings, plan };
}

// ---------------------------------------------------------------------------
// Dry run

/**
 * `options.dryRun`: compile and preflight only. No System One call, no
 * run row, no usage and no limiter tokens.
 */
export async function dryRunQuestionSet(
  _ctx: TenantContext,
  req: RunRequest,
  resolved: ResolvedRun,
  ports: RunPorts,
): Promise<RunDryRunResult> {
  const p = await prepare(req, resolved, ports);
  const warnings = [...p.warnings];
  if (p.spec.stages.some((s) => whenReadsAnswers(s) || (typeof s.stateFrom === "object" && s.stateFrom.merge.answers.length > 0))) {
    warnings.push(RUN_WARNINGS.dryRunAnswersUnknown);
  }
  return {
    dryRun: true,
    setId: resolved.setId,
    versionId: resolved.versionId,
    version: resolved.channel === "draft" ? "draft" : resolved.version,
    model: p.spec.model,
    profileId: (p.effective.profile as NonNullable<EffectiveModel["profile"]>).id,
    provider: p.provider,
    stages: p.plan.map((s) => ({
      id: s.id,
      skipped: s.skipped,
      batches: s.batches.map((b) => ({ request: b.request, estTokens: b.estTokens })),
    })),
    limits: {
      requestTokens: p.effective.limits.requestTokens,
      statePlusLongestQuestionTokens: p.effective.limits.statePlusLongestQuestionTokens,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The run

class RunFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: RunResult["status"] = "error",
  ) {
    super(code);
  }
}

/** A transport failure as the run's error code. An abort or an exhausted budget is system_one_unavailable. */
function failureCode(e: unknown): ErrorCode {
  if (!isTransportError(e)) return "system_one_unavailable";
  if (e.code === "client_aborted" || e.code === "llm_unavailable" || e.code === "llm_invalid_reply") {
    return "system_one_unavailable";
  }
  return e.code;
}

interface CallRecord {
  call: RunCall;
  reportedMicro: number | null;
  registryId: string | null;
}

export async function runQuestionSet(
  ctx: TenantContext,
  req: RunRequest,
  resolved: ResolvedRun,
  ports: RunPorts,
  control: RunControl,
): Promise<RunResult> {
  const startedAt = ports.clock();
  if (req.options.dryRun === true) {
    throw new RunRefusedError("invalid_request", "A dry run returns RunDryRunResult; call dryRunQuestionSet.");
  }
  const p = await prepare(req, resolved, ports);
  const { spec, settings } = resolved;
  const deadline = startedAt + control.budgetMs;
  const runId = ports.newId();
  const warnings = [...p.warnings];
  const warn = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  const stages: RunStage[] = spec.stages.map((s) => ({ id: s.id, skipped: false, calls: [] }));
  const callRecords: CallRecord[] = [];
  const answers: Record<QuestionId, SystemOneAnswer> = {};
  const views: Record<QuestionId, QuestionView> = {};
  const asked = new Set<QuestionId>();
  const stageStateTokens: number[] = [];
  const stateTokensByQuestion: Record<QuestionId, number> = {};
  const questionTokensById: Record<QuestionId, number> = {};
  let keyMode: "byo" | "platform" = "byo";
  let failure: RunFailure | null = null;

  try {
    // Step 8 (key) before step 7, so a refused unpriced run takes no limiter tokens.
    let apiKey: string;
    try {
      const key = await ports.keys(ctx, p.provider);
      apiKey = key.apiKey;
      keyMode = key.mode;
    } catch (e) {
      if (!isTransportError(e)) throw e;
      throw new RunFailure(failureCode(e));
    }
    if (keyMode === "platform" && p.provider === "typesafe") {
      const priced = await ports.prices.get(ctx.orgId, p.effective.resolvedId ?? spec.model, p.provider);
      if (priced === null) throw new RunRefusedError("model_unpriced", `The model ${spec.model} has no price, so a platform key run cannot be billed.`);
    }

    // Step 7: limiter and quota.
    const estTokens = p.plan.reduce((n, s) => n + s.batches.reduce((m, b) => m + b.estTokens, 0), 0);
    const limited = await ports.limiter(ctx, spec.model, estTokens, req.source === "eval" ? "eval" : "run");
    if (!limited.ok) throw new RunFailure("rate_limited", "rate_limited");
    const quota = await ports.quota(ctx, spec.model, estTokens);
    if (!quota.ok) throw new RunFailure(quota.code, "quota_exceeded");

    // Step 8: stages in order. A stage's `when` reads input, checks and earlier answers.
    for (const [i, stage] of spec.stages.entries()) {
      const record = stages[i] as RunStage;
      if (!stageRuns(stage, { input: p.input, checks: p.checks, questions: views, composites: {} })) {
        record.skipped = true;
        continue;
      }
      const state = stageState(stage, p.sentInput, views, answers);
      const pf = preflightStage(compileStageQuestions(stage), state, p.effective.providerModelId, p.effective.limits, spec.input.maxStateTokens);
      if (!pf.ok) throw new RunFailure("preflight_too_large");
      for (const w of pf.warnings) warn(w);
      stageStateTokens.push(pf.stateTokens);
      for (const qid of Object.keys(stage.questions)) {
        asked.add(qid);
        stateTokensByQuestion[qid] = pf.stateTokens;
        questionTokensById[qid] = pf.questionTokens[qid] as number;
      }

      const remaining = deadline - ports.clock();
      if (remaining <= 0 || control.signal.aborted) throw new RunFailure("system_one_unavailable");
      const budget = callBudget(remaining);
      const settled = await Promise.allSettled(
        pf.batches.map(async (batch) => {
          const began = ports.clock();
          const result = await ports.systemOne.call(batch.request, {
            provider: p.provider,
            apiKey,
            signal: control.signal,
            timeoutMs: budget.timeoutMs,
            retry: budget.retry,
          });
          return { batch, result, latencyMs: Math.max(0, ports.clock() - began) };
        }),
      );
      let stageFailure: unknown = null;
      for (const s of settled) {
        if (s.status === "rejected") {
          stageFailure ??= s.reason;
          continue;
        }
        const { batch, result, latencyMs } = s.value;
        const rec = recordCall(result.response, result.requestId, latencyMs, p.provider, p.routes);
        if (rec.registryId === null) warn(RUN_WARNINGS.modelResolvedUnmapped);
        callRecords.push(rec);
        record.calls.push(rec.call);
        for (const qid of batch.questionIds) {
          const raw = result.response.answers[qid];
          if (raw !== undefined) answers[qid] = raw;
        }
      }
      if (stageFailure !== null) throw new RunFailure(failureCode(stageFailure));
      for (const [qid, q] of Object.entries(stage.questions)) {
        views[qid] = readAnswer(q, spec.policies[qid], answers[qid]).view;
      }
    }
  } catch (e) {
    if (!(e instanceof RunFailure)) throw e;
    failure = e;
  }

  const resolvedIds = [...new Set(callRecords.map((r) => r.call.modelResolved))];
  if (resolvedIds.length > 1) warn(RUN_WARNINGS.modelResolvedMixed);

  // System One cost, per call, by each call's own resolved model.
  const callCosts: Array<number | null> = [];
  for (const r of callRecords) {
    const price = r.reportedMicro === null && r.registryId !== null ? await ports.prices.get(ctx.orgId, r.registryId, p.provider) : null;
    callCosts.push(callCostMicro({ inputTokens: r.call.inputTokens, outputTokens: r.call.outputTokens, reportedMicro: r.reportedMicro }, price));
  }
  const systemOneCostMicro = sumCostMicro(callCosts);
  if (systemOneCostMicro === null) warn(RUN_WARNINGS.modelUnpriced);

  const stage = routingStage(resolved.rollout, resolved.channel);
  const outage = failure !== null && isOutageCode(failure.code);
  if (outage) warn(RUN_WARNINGS.systemOneOutage);
  const suppressed = outage
    ? "outage"
    : savingsSuppression({ source: req.source, arm: resolved.experiment?.arm, channel: resolved.channel, routingStage: stage });
  const comparatorModel = spec.savings?.comparatorModel ?? settings.defaultComparatorModel;
  const comparatorPrice = await ports.prices.get(ctx.orgId, comparatorModel);
  const estOut = spec.savings?.estOutputTokensPerQuestion ?? DEFAULT_EST_OUTPUT_TOKENS_PER_QUESTION;

  let decisions: Record<string, Decision> = {};
  let runBand: RunResult["runBand"] = "low";
  let overallAction: Action = "fallback";
  let route: string | null = null;
  let escalationCostMicro = 0;
  let llmCallsMade = 0;
  let escalated = false;
  let counted: CountedQuestion[] = [];
  let relevantQuestions: CountedQuestion[] = [];
  const pendingActions: Array<{ decisionId: string; handlerId: string; config: unknown }> = [];

  if (failure === null || outage) {
    // Step 9: route. On an outage every decision takes the set's outage rule.
    const routed = outage
      ? routeOutage({
          spec,
          skipped: new Set(spec.stages.flatMap((s, i) => ((stages[i] as RunStage).skipped ? Object.keys(s.questions) : []))),
          rollout: resolved.rollout,
          channel: resolved.channel,
          arm: resolved.experiment?.arm,
        })
      : routeAnswers({
          spec,
          answers,
          asked,
          checks: p.checks,
          input: p.input,
          rollout: resolved.rollout,
          channel: resolved.channel,
          dispatchActionsOnStaging: settings.dispatchActionsOnStaging,
          arm: resolved.experiment?.arm,
        });
    for (const w of routed.warnings) warn(w);
    decisions = routed.decisions;

    // Step 10: set fallbacks and escalations, inside the latency budget.
    for (const [id, d] of Object.entries(decisions)) {
      const meta = routed.meta[id] as DecisionMeta;
      const fallback = fallbackConfigOf(meta.actionRef);
      if (d.executed && d.effectiveAction === "fallback" && fallback?.kind === "set") {
        const linkedRunId = await runLinked(ports, req, resolved, runId, fallback.setRef, control);
        if (linkedRunId.runId !== null) d.fallbackRunId = linkedRunId.runId;
        if (!linkedRunId.ok) warn(RUN_WARNINGS.fallbackSetFailed);
      }
      const escalation = escalationConfigOf(meta.actionRef);
      if (d.executed && d.effectiveAction === "escalate_to_llm" && escalation !== null && meta.kind === "question") {
        escalated = true;
        const question = spec.stages.flatMap((s) => Object.entries(s.questions)).find(([qid]) => qid === id)?.[1];
        const model = escalationModel(escalation, spec.savings?.comparatorModel, settings.defaultComparatorModel);
        const stageIndex = spec.stages.findIndex((s) => Object.hasOwn(s.questions, id));
        const state = stageState(spec.stages[stageIndex] as (typeof spec.stages)[number], p.sentInput, views, answers);
        let ok = false;
        if (ports.llm !== undefined && question !== undefined) {
          llmCallsMade += 1;
          try {
            const completion = await ports.llm.complete({ ...buildEscalationRequest(question, escalation, state, model), signal: control.signal });
            const price = await ports.prices.get(ctx.orgId, completion.model);
            if (price === null) warn(RUN_WARNINGS.escalationUnpriced);
            const cost = callCostMicro({ inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, reportedMicro: null }, price) ?? 0;
            escalationCostMicro += cost;
            const value = parseEscalationReply(question, completion.text);
            ok = value !== null;
            d.escalation = ok
              ? { model: completion.model, value, costUsd: usdFromMicro(cost), status: "ok" }
              : { model: completion.model, value: null, costUsd: usdFromMicro(cost), status: "failed", error: "llm_invalid_reply" };
          } catch (e) {
            d.escalation = { model, value: null, costUsd: 0, status: "failed", error: isTransportError(e) ? e.code : "llm_unavailable" };
          }
        } else {
          d.escalation = { model, value: null, costUsd: 0, status: "failed", error: "llm_unavailable" };
        }
        if (!ok) {
          d.effectiveAction = "review";
          warn(RUN_WARNINGS.escalationFailed);
        }
      }
      // Step 12 is after commit; decide what to enqueue now so the warning is stored with the run.
      const handler = meta.actionRef?.handler;
      if (d.executed && d.effectiveAction === "auto" && handler !== undefined) {
        if (await ports.actions.isEnabled(ctx.orgId, handler)) {
          pendingActions.push({ decisionId: id, handlerId: handler, config: meta.actionRef?.kind === "auto" ? (meta.actionRef.config ?? null) : null });
        } else warn(RUN_WARNINGS.handlerDisabled);
      }
    }
    const summary = summarizeDecisions(decisions, routed.meta);
    runBand = summary.runBand;
    overallAction = summary.overallAction;
    route = routed.route;

    // Savings count relevant questions whose effective action is auto. A shadow run counts what the
    // policy would have done, so its suppressed would-be savings mean something. An outage counts
    // nothing.
    for (const [id, d] of Object.entries(decisions)) {
      if (outage || d.kind !== "question" || !d.relevant || !asked.has(id)) continue;
      const q = { stateTokens: stateTokensByQuestion[id] as number, questionTokens: questionTokensById[id] as number };
      relevantQuestions.push(q);
      const acts = suppressed === "shadow" ? d.action : d.effectiveAction;
      if (acts === "auto") counted.push(q);
    }
  } else {
    counted = [];
    relevantQuestions = [];
  }

  if (comparatorPrice === null) warn(RUN_WARNINGS.comparatorUnpriced);
  const savings = computeSavings({
    kind: spec.savings?.kind ?? "decision",
    mode: "one_call",
    counted,
    stageStateTokens,
    estOutputTokensPerQuestion: estOut,
    comparatorPrice,
    systemOneCostMicro,
    escalationCostMicro,
    escalated,
    avgEscalationCostMicro: settings.avgEscalationCostMicroUsd,
    relevant: relevantQuestions,
    tokensBefore: req.options.metadata?.tokensBefore,
    tokensAfter: req.options.metadata?.tokensAfter,
    suppressed,
  });

  const allCalls = stages.flatMap((s) => s.calls);
  const cost: RunCost = {
    systemOneInputTokens: allCalls.reduce((n, c) => n + c.inputTokens, 0),
    systemOneOutputTokens: allCalls.reduce((n, c) => n + c.outputTokens, 0),
    systemOneCostUsd: systemOneCostMicro === null ? null : usdFromMicro(systemOneCostMicro),
    counterfactualInputTokens: savings.cfInputTokens,
    counterfactualOutputTokens: savings.cfOutputTokens,
    counterfactualLlmCostUsd: usdFromMicro(savings.counterfactualMicro),
    comparatorModel,
    counterfactualMode: "one_call",
    savingsUsd: usdFromMicro(savings.savingsMicro),
    savingsKind: spec.savings?.kind ?? "decision",
    savingsSuppressed: suppressed,
    llmCallsAvoided: savings.llmCallsAvoided,
    escalationCostUsd: usdFromMicro(escalationCostMicro),
    llmCallsMade,
    estimated: true,
    latencyMs: Math.max(0, ports.clock() - startedAt),
  };
  if (savings.contextTokensPruned !== undefined) cost.contextTokensPruned = savings.contextTokensPruned;

  const first = allCalls[0];
  const result: RunResult = {
    runId,
    setId: resolved.setId,
    version: resolved.version,
    versionId: resolved.versionId,
    interfaceMajor: resolved.interfaceMajor,
    interfaceHash: resolved.interfaceHash,
    channel: resolved.channel,
    rollout: stage,
    status: failure === null ? "ok" : failure.status,
    modelRequested: spec.model,
    modelResolved: first?.modelResolved ?? null,
    typesafeRequestId: first?.typesafeRequestId ?? null,
    stages,
    checks: p.checks,
    answers,
    decisions,
    runBand,
    overallAction,
    route,
    cost,
    warnings,
  };
  if (resolved.experiment !== undefined) result.experiment = resolved.experiment;
  if (failure !== null) result.error = { code: failure.code, message: runErrorMessage(failure.code) };

  // Step 11: persist in one transaction.
  const stored =
    settings.storageMode === "hash_only"
      ? null
      : settings.storageMode === "full" && settings.piiMode === "off"
        ? p.input
        : p.sentInput;
  const persisted = await ports.runs.persist(ctx, {
    result,
    request: req,
    state: stored,
    stateHash: hashJson(req.state),
    stages: stages.map((s) => ({
      id: s.id,
      skipped: s.skipped,
      inputTokens: s.calls.reduce((n, c) => n + c.inputTokens, 0),
      outputTokens: s.calls.reduce((n, c) => n + c.outputTokens, 0),
      latencyMs: s.calls.reduce((n, c) => Math.max(n, c.latencyMs), 0),
      typesafeRequestId: s.calls[0]?.typesafeRequestId ?? null,
    })),
    keyMode,
    provider: p.provider,
    parentRunId: null,
  });
  if (persisted.reviewItemIds.length > 0) result.reviewItemIds = persisted.reviewItemIds;

  // Step 12: dispatch after commit. Idempotent by runId:decisionId.
  for (const a of pendingActions) await ports.actions.enqueue({ runId, ...a });
  return result;
}

/** One System One response as a RunCall, with its provider-reported cost and registry id. */
function recordCall(
  response: SystemOneResponse,
  requestId: string | null,
  latencyMs: number,
  provider: SystemOneProvider,
  routes: readonly ModelRoute[],
): CallRecord {
  const reportedMicro = responseCostMicroUsd(response);
  const call: RunCall = {
    modelResolved: response.model,
    provider,
    typesafeRequestId: requestId,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    latencyMs,
  };
  if (reportedMicro !== null) call.providerCostUsd = usdFromMicro(reportedMicro);
  return { call, reportedMicro, registryId: registryIdForResolved(provider, response.model, routes) };
}

/** A `set` fallback through ports.linkedRun. Never throws. */
async function runLinked(
  ports: RunPorts,
  req: RunRequest,
  resolved: ResolvedRun,
  parentRunId: string,
  setRef: string,
  control: RunControl,
): Promise<{ ok: boolean; runId: string | null }> {
  if (ports.linkedRun === undefined) return { ok: false, runId: null };
  const channel =
    resolved.channel === "production" || resolved.channel === "staging" ? resolved.channel : (req.channel ?? "production");
  try {
    const linked = await ports.linkedRun(setRef, req.state, { channel, parentRunId, signal: control.signal });
    return { ok: linked.status === "ok", runId: linked.runId };
  } catch {
    return { ok: false, runId: null };
  }
}

/** Price one call for tests and reports: the provider's cost when reported, else the price book row. */
export function priceCall(
  call: Pick<RunCall, "inputTokens" | "outputTokens" | "providerCostUsd">,
  price: ModelPrice | null,
): number | null {
  const reported = call.providerCostUsd === undefined ? null : microFromUsd(call.providerCostUsd);
  return callCostMicro({ inputTokens: call.inputTokens, outputTokens: call.outputTokens, reportedMicro: reported }, price);
}
