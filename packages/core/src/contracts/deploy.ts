// App integration contracts: deploy targets and opportunities.

import { z } from "zod";

import { AppId, IsoTimestamp, OrgId, SetId, TokenId, UserId, Uuid } from "./common.js";
import { QuestionTypeId } from "./question-types.js";

// ---------------------------------------------------------------------------
// Deploy targets

/** How an app runs a set. Build order: managed, managed_typed, standalone. */
export const DeployTarget = z.enum(["managed", "managed_typed", "standalone"]);
export type DeployTarget = z.infer<typeof DeployTarget>;

export const DEFAULT_DEPLOY_TARGET: DeployTarget = "managed";

/** `apps.language`. Picks the default codegen target. */
export const AppLanguage = z.enum(["ts", "py", "other"]);
export type AppLanguage = z.infer<typeof AppLanguage>;

/** `app_set_bindings.runtime`. */
export const BindingRuntime = z.enum(["ts", "py", "http"]);
export type BindingRuntime = z.infer<typeof BindingRuntime>;

// ---------------------------------------------------------------------------
// Opportunities

/** Who proposed the opportunity. */
export const OpportunitySource = z.enum(["agent", "console"]);
export type OpportunitySource = z.infer<typeof OpportunitySource>;

/** What the app does today at this decision point. */
export const CurrentApproach = z.enum(["regex", "if_else", "llm_call", "manual", "other"]);
export type CurrentApproach = z.infer<typeof CurrentApproach>;

/** The pattern advisor's tag. It picks the spec skeleton Studio step 3 starts from. */
export const Pattern = z.enum([
  "fan_out",
  "confidence_routing",
  "composite_scoring",
  "intent_routing",
  "cascade",
  "top_choice",
  "keep_in_code",
]);
export type Pattern = z.infer<typeof Pattern>;

/** proposed to accepted or rejected; accepted to built once a set is linked. */
export const OpportunityStatus = z.enum(["proposed", "accepted", "rejected", "built"]);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

/** A path and a line range such as "120-148". Never file contents. */
export const OpportunityLocation = z.strictObject({
  file: z.string().min(1),
  lines: z.string().min(1),
});
export type OpportunityLocation = z.infer<typeof OpportunityLocation>;

const opportunityShape = {
  appId: AppId,
  source: OpportunitySource,
  location: OpportunityLocation.nullable(),
  currentApproach: CurrentApproach,
  /** Plain language, for example "decide whether an inbound email needs a reply today". */
  decisionSummary: z.string().min(1),
  primitiveGuess: QuestionTypeId,
  pattern: Pattern,
  /** Passes the Studio's 10-second fit test. */
  tenSecondFit: z.boolean(),
  status: OpportunityStatus,
  setId: SetId.nullable(),
};

function builtNeedsSet(o: { status: OpportunityStatus; setId: string | null }, ctx: z.RefinementCtx): void {
  if (o.status === "built" && o.setId === null) {
    ctx.addIssue({ code: "custom", path: ["setId"], message: "a built opportunity links a set" });
  }
}

/**
 * One place in an app where a System One decision could replace fragile code or an LLM call.
 * Both producers (the agent path and the console path) write this. Strict, so no extra field
 * (such as pasted source code) can ride along.
 */
export const Opportunity = z.strictObject(opportunityShape).superRefine(builtNeedsSet);
export type Opportunity = z.infer<typeof Opportunity>;

/**
 * An `app_opportunities` row: the contract plus the fields the server adds. Like the other row
 * schemas it strips unknown keys, so a column added by a later migration does not break an older
 * reader. The input-side Opportunity stays strict.
 */
export const OpportunityRecord = z
  .object({
    ...opportunityShape,
    id: Uuid,
    orgId: OrgId,
    createdByUserId: UserId.nullable(),
    createdByTokenId: TokenId.nullable(),
    createdAt: IsoTimestamp,
  })
  .superRefine(builtNeedsSet);
export type OpportunityRecord = z.infer<typeof OpportunityRecord>;
