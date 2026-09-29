// @bandwise/templates: the template pack. Pure data plus lookups. Depends only on @bandwise/core.
//
// Each template is a complete QuestionSetSpec with metadata (job, when to use it, when not to),
// two or three example states and one borderline case per question. Copy a spec into your repo as
// bandwise/sets/<slug>.json, edit it, and try it with `bandwise run --local`.

import { actionRiskGate } from "./templates/action-risk-gate.js";
import { contextPruner } from "./templates/context-pruner.js";
import { doneCheck } from "./templates/done-check.js";
import { emailTriage } from "./templates/email-triage.js";
import { errorTriage } from "./templates/error-triage.js";
import { inboundEmailRouting } from "./templates/inbound-email-routing.js";
import { leadEventScoring } from "./templates/lead-event-scoring.js";
import { logLinePager } from "./templates/log-line-pager.js";
import { modelTier } from "./templates/model-tier.js";
import { prSafetyGate } from "./templates/pr-safety-gate.js";
import { securityFindingTriage } from "./templates/security-finding-triage.js";
import { wakeGate } from "./templates/wake-gate.js";
import type { Template } from "./types.js";

export { type BorderlineCase, type Template, type TemplateExample, defineTemplate } from "./types.js";
export { renderSkillFiles } from "./skill-files.js";

/** Every template in the pack, in the order the docs list them. */
export const TEMPLATES: readonly Template[] = Object.freeze([
  emailTriage,
  prSafetyGate,
  logLinePager,
  contextPruner,
  wakeGate,
  doneCheck,
  actionRiskGate,
  modelTier,
  securityFindingTriage,
  errorTriage,
  leadEventScoring,
  inboundEmailRouting,
]);

/** Template ids, in pack order. */
export const TEMPLATE_IDS: readonly string[] = Object.freeze(TEMPLATES.map((t) => t.id));

/** The template with this id, or null. */
export function getTemplate(id: string): Template | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
