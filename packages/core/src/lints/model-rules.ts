// Lints that read the target model's profile, and the publish-time lints that read PublishCtx.

import type { ModelProfile } from "../contracts/models.js";
import { resolveRoute } from "../contracts/models.js";
import type { ActionRef, CompositeActionRef } from "../contracts/policy.js";
import type { LintResult, QuestionSetSpec } from "../contracts/spec.js";
import type { PublishCtx } from "../contracts/tenant.js";
import { diffInterface, interfaceOf } from "../interface.js";
import { compileQuestion } from "../question-types/index.js";
import { estimateTokens } from "../util/tokens.js";
import { finding, questionEntries, seg } from "./helpers.js";

const NEAR_LIMIT_RATIO = 0.8;

/** model.unknown, model.unreviewed, model.deprecated, model.question_type_unsupported, tokens.near_limit. */
export function profileLints(spec: QuestionSetSpec, profile: ModelProfile | null): LintResult[] {
  if (profile === null) {
    return [finding("model.unknown", "error", "/model", `model "${spec.model}" is not in the registry`)];
  }
  const out: LintResult[] = [];
  if (profile.status === "unreviewed") {
    out.push(finding("model.unreviewed", "error", "/model", `model "${spec.model}" is unreviewed; it runs in the playground only`));
  }
  if (profile.status === "deprecated") {
    out.push(finding("model.deprecated", "warning", "/model", `model "${spec.model}" is deprecated${profile.retireAt === null ? "" : ` and retires on ${profile.retireAt}`}`));
  }
  if (profile.status === "retired") {
    out.push(finding("model.deprecated", "error", "/model", `model "${spec.model}" is retired`));
  }
  for (const { question, path } of questionEntries(spec)) {
    if (!profile.questionTypes.includes(question.type)) {
      out.push(finding("model.question_type_unsupported", "error", `${path}/type`, `model "${spec.model}" does not answer ${question.type} questions`));
    }
  }
  if (profile.limits !== null) {
    const state = spec.input.maxStateTokens ?? 0;
    spec.stages.forEach((stage, i) => {
      const tokens = Object.entries(stage.questions).map(([id, q]) => estimateTokens({ [id]: compileQuestion(q) }));
      const total = tokens.reduce((n, t) => n + t, 0) + state;
      const longest = Math.max(0, ...tokens) + state;
      const limits = profile.limits as NonNullable<ModelProfile["limits"]>;
      if (total > NEAR_LIMIT_RATIO * limits.requestTokens || longest > NEAR_LIMIT_RATIO * limits.statePlusLongestQuestionTokens) {
        out.push(finding("tokens.near_limit", "warning", `/stages/${i}`, `stage "${stage.id}" is estimated above 80 percent of a model limit`));
      }
    });
  }
  return out;
}

/** Every action ref in the spec with its JSON Pointer. */
function actionRefs(spec: QuestionSetSpec): Array<{ ref: ActionRef | CompositeActionRef; path: string; question: string | null }> {
  const out: Array<{ ref: ActionRef | CompositeActionRef; path: string; question: string | null }> = [];
  for (const [key, policy] of Object.entries(spec.policies)) {
    for (const band of ["high", "medium", "low"] as const) {
      out.push({ ref: policy.actions[band], path: `/policies/${seg(key)}/actions/${band}`, question: key });
    }
  }
  (spec.composites ?? []).forEach((c, i) => {
    if (c.policy === undefined) return;
    for (const band of ["high", "medium", "low"] as const) {
      out.push({ ref: c.policy.actions[band], path: `/composites/${i}/policy/actions/${band}`, question: null });
    }
  });
  return out;
}

/** privacy.hash_only_with_review needs only the flag; the rest need the full PublishCtx. */
export function publishLints(spec: QuestionSetSpec, profile: ModelProfile | null, ctx: PublishCtx): LintResult[] {
  const out: LintResult[] = [];

  const route = profile === null ? null : resolveRoute(profile, ctx.systemOneProvider, ctx.modelRoutes);
  if (!ctx.reachableModels.includes(spec.model)) {
    out.push(finding("model.not_available_to_org", "error", "/model", `the org's ${ctx.systemOneProvider} key cannot reach "${spec.model}"`));
  } else if (profile !== null && route === null) {
    out.push(finding("model.not_available_to_org", "error", "/model", `${ctx.systemOneProvider} has no route for "${spec.model}"`));
  } else if (profile?.status === "preview" && !ctx.allowPreviewModels) {
    out.push(finding("model.not_available_to_org", "error", "/model", `"${spec.model}" is a preview model and the org has not opted in`));
  }
  if ((ctx.rolloutStage === "controlled" || ctx.rolloutStage === "full") && route?.pinned !== true) {
    out.push(
      finding("model.alias_past_shadow", "error", "/model", `"${spec.model}" is a moving model; pin a versioned model before a channel is ${ctx.rolloutStage}`),
    );
  }

  for (const { ref, path, question } of actionRefs(spec)) {
    if (ref.handler !== undefined && !ctx.enabledHandlers.includes(ref.handler)) {
      out.push(finding("action.handler_unknown", "error", `${path}/handler`, `handler "${ref.handler}" is not installed and enabled for the org`));
    }
    if (ref.kind === "fallback" && ref.config?.kind === "set") {
      const target = ctx.fallbackSets[ref.config.setRef];
      if (target === undefined) {
        out.push(finding("fallback.set_invalid", "error", `${path}/config/setRef`, `fallback set "${ref.config.setRef}" does not exist`));
      } else if (target.usesSetFallback) {
        out.push(finding("fallback.set_invalid", "error", `${path}/config/setRef`, `fallback set "${ref.config.setRef}" uses a set fallback itself`));
      }
    }
    if (ref.kind === "escalate_to_llm" && question !== null) {
      const model = ref.config?.model ?? spec.savings?.comparatorModel;
      if (model !== undefined && !ctx.pricedModels.includes(model)) {
        out.push(finding("escalation.model_unpriced", "error", `${path}/config`, `escalation model "${model}" has no price row`));
      }
    }
  }

  const next = interfaceOf(spec);
  for (const served of ctx.served) {
    if (!served.hasConsumers || ctx.newMajor !== served.interfaceMajor) continue;
    const { breaking } = diffInterface(served.interface, next);
    if (breaking.length > 0) {
      out.push(
        finding(
          "interface.breaking",
          "error",
          "",
          `breaking change for ${served.channel} consumers (${breaking.join("; ")}); bump the interface major with a reason`,
        ),
      );
    }
  }

  if (ctx.hashOnly && actionRefs(spec).some((a) => a.ref.kind === "review")) {
    out.push(finding("privacy.hash_only_with_review", "warning", "/policies", "the set stores hashes only, so reviewers cannot see what they review"));
  }
  return out;
}
