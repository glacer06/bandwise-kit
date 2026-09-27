// lint(spec, profile, publishCtx?): every rule (Lints and Model weakness lints).
// Pure. Errors block publish; warnings do not. Rule ids are stable: never rename one.

import type { ModelProfile } from "../contracts/models.js";
import type { LintResult, QuestionSetSpec } from "../contracts/spec.js";
import type { PublishCtx } from "../contracts/tenant.js";
import { profileLints, publishLints } from "./model-rules.js";
import { moduleLints, outageLints, pathLints, policyLints, stageLints } from "./spec-rules.js";
import { weaknessLints } from "./weakness-rules.js";

/** Every lint rule id core emits. */
export const LINT_RULES = [
  "choice.missing_none",
  "choice.too_many_options",
  "score.levels_range",
  "state_path.unknown",
  "policy.thresholds_order",
  "policy.noul_order",
  "policy.per_option_keys",
  "policy.type_mismatch",
  "policy.all_gating_thresholded",
  "stage.same_stage_dependency",
  "stage.needless_second_call",
  "relevance.premise_missing",
  "tokens.near_limit",
  "instructions.too_short",
  "redact.path_unknown",
  "action.handler_unknown",
  "fallback.set_invalid",
  "model.unknown",
  "model.unreviewed",
  "model.not_available_to_org",
  "model.deprecated",
  "model.question_type_unsupported",
  "model.alias_past_shadow",
  "escalation.model_unpriced",
  "interface.breaking",
  "privacy.hash_only_with_review",
  "weakness.counting",
  "weakness.date_comparison",
  "weakness.inverted_noul",
  "weakness.generation",
  "weakness.large_unreferenced_state",
  "weakness.threshold_copied",
  "outage.auto_not_allowed",
  "outage.fallback_silent",
] as const;
export type LintRule = (typeof LINT_RULES)[number];

/**
 * Lint a spec against the target model's profile (null when the model is not in the registry).
 * Rules that need a PublishCtx are skipped without one; publish and promote always pass it.
 */
export function lint(spec: QuestionSetSpec, profile: ModelProfile | null, publishCtx?: PublishCtx): LintResult[] {
  return [
    ...moduleLints(spec),
    ...pathLints(spec),
    ...stageLints(spec),
    ...policyLints(spec),
    ...outageLints(spec),
    ...profileLints(spec, profile),
    ...weaknessLints(spec, profile),
    ...(publishCtx === undefined ? [] : publishLints(spec, profile, publishCtx)),
  ];
}

/** True when any finding is an error, which blocks publish. */
export function hasLintErrors(results: readonly LintResult[]): boolean {
  return results.some((r) => r.severity === "error");
}
