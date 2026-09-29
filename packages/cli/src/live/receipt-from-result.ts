// Turn a RunResult into a receipt: decisions, bands, actions, cost and savings. Never the state.

import type { RunResult } from "@bandwise/core";
import { RECEIPT_SCHEMA_VERSION, type Receipt, type ReceiptDecision } from "../receipts/index.js";

export interface ReceiptMeta {
  set: string;
  specHash: string;
  source: string;
  provider: string;
  at: string;
  acted: boolean;
}

/** A receipt for a run that finished, ok or failed. */
export function receiptFromResult(result: RunResult, meta: ReceiptMeta): Receipt {
  const decisions: Record<string, ReceiptDecision> = {};
  for (const [id, d] of Object.entries(result.decisions)) {
    decisions[id] = { value: d.value, band: d.band, action: d.action, effectiveAction: d.effectiveAction, relevant: d.relevant };
  }
  const c = result.cost;
  return {
    v: RECEIPT_SCHEMA_VERSION,
    at: meta.at,
    set: meta.set,
    specHash: meta.specHash,
    source: meta.source,
    provider: meta.provider,
    rollout: result.rollout,
    status: result.status === "ok" ? "ok" : (result.error?.code ?? result.status),
    modelRequested: result.modelRequested,
    modelResolved: result.modelResolved,
    route: result.route,
    runBand: result.runBand,
    overallAction: result.overallAction,
    decisions,
    acted: meta.acted,
    systemOneCostUsd: c.systemOneCostUsd,
    counterfactualLlmCostUsd: c.counterfactualLlmCostUsd,
    comparatorModel: c.comparatorModel,
    savingsUsd: c.savingsUsd,
    savingsSuppressed: c.savingsSuppressed,
    latencyMs: c.latencyMs,
  };
}

/** A receipt for a run that never produced a result: a timeout or an error before the envelope. */
export function failureReceipt(meta: ReceiptMeta & { rollout: string; modelRequested: string; status: string; latencyMs: number }): Receipt {
  return {
    v: RECEIPT_SCHEMA_VERSION,
    at: meta.at,
    set: meta.set,
    specHash: meta.specHash,
    source: meta.source,
    provider: meta.provider,
    rollout: meta.rollout,
    status: meta.status,
    modelRequested: meta.modelRequested,
    modelResolved: null,
    route: null,
    runBand: null,
    overallAction: null,
    decisions: {},
    acted: false,
    systemOneCostUsd: null,
    counterfactualLlmCostUsd: 0,
    comparatorModel: null,
    savingsUsd: 0,
    savingsSuppressed: null,
    latencyMs: meta.latencyMs,
  };
}
