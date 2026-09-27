// The normative stage x band x action table.
// This file is the only place it is enforced. No other package reinterprets it.

import type { Action, Band, Channel, ExperimentArm, RolloutStage } from "../contracts/common.js";

/** slug@draft runs behave as shadow; every other channel uses its pointer's stage. */
export function routingStage(rollout: RolloutStage, channel: Channel): RolloutStage {
  return channel === "draft" ? "shadow" : rollout;
}

/** True for the stages whose rows never execute: every effective action is a forced fallback. */
export function isShadowLike(stage: RolloutStage): boolean {
  return stage === "shadow" || stage === "paused" || stage === "inactive";
}

export interface EffectiveActionInput {
  /** The routing stage (routingStage of the pointer stage and channel). */
  stage: RolloutStage;
  band: Band;
  /** The policy action. */
  action: Action;
  gating: boolean;
  relevant: boolean;
}

/**
 * The action callers act on. Irrelevant decisions are fallback in every stage. `inactive` never
 * reaches the router (the channel returns 409 set_not_live), so it is treated like shadow here.
 */
export function effectiveAction(i: EffectiveActionInput): Action {
  if (!i.relevant) return "fallback";
  switch (i.stage) {
    case "full":
      return i.action;
    case "controlled":
      if (i.band === "high") return i.action;
      return i.gating ? "review" : "fallback";
    case "inactive":
    case "shadow":
    case "paused":
      return "fallback";
  }
}

export interface OutageActionInput {
  /** The routing stage (routingStage of the pointer stage and channel). */
  stage: RolloutStage;
  kind: "question" | "composite";
  gating: boolean;
  relevant: boolean;
  /** The spec's outage rule, default applied. Never auto. */
  onUnavailable: "fallback" | "review" | "escalate_to_llm";
}

/**
 * The effective action of a decision when System One was unavailable after retries.
 * Never auto. Relevant gating decisions take the set's
 * outage rule in controlled and full. Shadow, paused and inactive never act, so they stay fallback.
 * Non-gating decisions are fallback, as in the low band of controlled. A composite has no answer
 * type for an LLM to return, so an escalate_to_llm rule becomes review for it.
 */
export function outageEffectiveAction(i: OutageActionInput): Action {
  if (!i.relevant || !i.gating || isShadowLike(i.stage)) return "fallback";
  if (i.kind === "composite" && i.onUnavailable === "escalate_to_llm") return "review";
  return i.onUnavailable;
}

/**
 * Decision.executed on an outage: true when the run creates a review item or makes the LLM call.
 * An outage fallback runs nothing (no policy fallback config applies), so it is false, as it is on
 * the challenger arm. The stages that never act already resolve to fallback.
 */
export function isOutageExecuted(i: { effectiveAction: Action; arm: ExperimentArm | undefined }): boolean {
  if (i.arm === "challenger") return false;
  return i.effectiveAction === "review" || i.effectiveAction === "escalate_to_llm";
}

export interface ExecutedInput {
  stage: RolloutStage;
  /** The decision's band (a composite's certainty band). */
  band: Band;
  relevant: boolean;
  action: Action;
  effectiveAction: Action;
  /** The handler on the policy action, when it names one. */
  handler: string | undefined;
  channel: Channel;
  dispatchActionsOnStaging: boolean;
  arm: ExperimentArm | undefined;
}

/**
 * Decision.executed: whether the run created or dispatched something for this decision. True for
 * a review item, and on a row marked Yes when the effective action equals the policy action (auto
 * dispatch, the LLM call, the configured fallback). False for a forced fallback, for auto with a
 * handler on staging without dispatchActionsOnStaging, and on the challenger arm.
 */
export function isExecuted(i: ExecutedInput): boolean {
  if (!i.relevant || i.arm === "challenger") return false;
  if (i.stage !== "controlled" && i.stage !== "full") return false;
  if (i.effectiveAction === "review") return true;
  // controlled, medium or low, not gating: a forced fallback, even when the policy also says fallback.
  if (i.stage === "controlled" && i.band !== "high") return false;
  // Here the row is marked Yes, so the effective action is the policy action.
  if (i.action === "auto" && i.handler !== undefined && i.channel === "staging" && !i.dispatchActionsOnStaging) {
    return false;
  }
  return true;
}
