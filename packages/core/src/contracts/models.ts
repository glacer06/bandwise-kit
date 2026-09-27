// The System One model registry contract: one ModelProfile per row of `system_one_models`.
// ModelRoute (one row of `system_one_model_routes`, per model and provider) is.
//
// Model facts are data. Limits, question types and weaknesses come from these rows, never from
// constants in code. Prices are not part of a profile: they live in `price_books`, keyed by the
// exact versioned id, and reach core through the PriceBook port.

import { z } from "zod";

import { QuestionTypeId } from "./question-types.js";
import { SystemOneProvider, defaultProviderModelId } from "./system-one.js";

const IsoDate = z.iso.date();

// ---------------------------------------------------------------------------
// Enums

/** Only `versioned` rows are pinned. Aliases, partial ids and unknown names are moving. */
export const ModelKind = z.enum(["versioned", "alias"]);
export type ModelKind = z.infer<typeof ModelKind>;

/** Registry lifecycle. */
export const ModelStatus = z.enum(["unreviewed", "preview", "stable", "deprecated", "retired"]);
export type ModelStatus = z.infer<typeof ModelStatus>;

/**
 * Weakness ids documented for jev-1.13.0. A profile's
 * `weaknesses` is a plain string list, so a future model can carry an id that is not listed here.
 * Weakness lints fire only for ids the target profile lists.
 */
export const KNOWN_WEAKNESS_IDS = [
  "literal_reading",
  "counting",
  "arithmetic",
  "numeric_precision",
  "date_comparison",
  "indirection",
  "large_irrelevant_state",
  "adversarial_state",
  "contradictory_criteria",
  "inverted_noul",
  "structural_invariants",
  "generation",
] as const;

export const WeaknessId = z.enum(KNOWN_WEAKNESS_IDS);
export type WeaknessId = z.infer<typeof WeaknessId>;

// ---------------------------------------------------------------------------
// Limits

const PositiveInt = z.number().int().positive();

/** Published per-model limits. Rate limits can change without notice; treat them as of `lastReviewed`. */
export const ModelLimits = z
  .strictObject({
    /** State plus all questions. */
    requestTokens: PositiveInt,
    statePlusLongestQuestionTokens: PositiveInt,
    /** Published requests per minute per account. */
    rpm: PositiveInt,
    tokensPerSec: PositiveInt,
  })
  .refine((l) => l.statePlusLongestQuestionTokens <= l.requestTokens, {
    path: ["statePlusLongestQuestionTokens"],
    message: "must not exceed requestTokens",
  });
export type ModelLimits = z.infer<typeof ModelLimits>;

// ---------------------------------------------------------------------------
// ModelProfile

/**
 * One registry row. Strict: the platform admin writes these by hand, so a misspelled key fails.
 *
 * Rules checked here:
 * - `limits` is null only on an `unreviewed` row.
 * - `aliasTarget` is set only on alias rows (a versioned row never points elsewhere).
 * - `questionTypes` has no duplicates.
 */
const modelProfileShape = {
  /** "jev-1.13.0", "jev-latest". TypeSafe's name, kept as is. */
  id: z.string().min(1),
  /** "jev". */
  family: z.string().min(1),
  kind: ModelKind,
  /** Last observed versioned id, aliases only. Null until detection sees one. */
  aliasTarget: z.string().min(1).nullable(),
  status: ModelStatus,
  /** YYYY-MM-DD. */
  releaseDate: IsoDate.nullable(),
  /** YYYY-MM-DD. After this date the row is `retired`. */
  retireAt: IsoDate.nullable(),
  /** Subset of the closed v1 union. */
  questionTypes: z.array(QuestionTypeId),
  /** Null only while `unreviewed`. */
  limits: ModelLimits.nullable(),
  /** ["text"]. */
  inputModalities: z.array(z.string().min(1)),
  /** Weakness ids, see KNOWN_WEAKNESS_IDS. */
  weaknesses: z.array(z.string().min(1)),
  /**
   * Model or family ids this model can replace. Set by
   * the platform admin at review; [] for none. Required: without it a new family never shows up
   * as an upgrade. Rows written before this field are backfilled by the migration, not here.
   */
  supersedes: z.array(z.string().min(1)),
  docsUrl: z.url(),
  jaggednessUrl: z.url().nullable(),
  /** YYYY-MM-DD: the date a human checked the row against the docs. */
  lastReviewed: IsoDate,
};

/** The row rules listed above, shared by ModelProfile and ModelListItem. */
function checkModelProfile(
  p: z.output<z.ZodObject<typeof modelProfileShape>>,
  ctx: z.RefinementCtx,
): void {
  if (p.limits === null && p.status !== "unreviewed") {
    ctx.addIssue({
      code: "custom",
      path: ["limits"],
      message: `limits may be null only on an unreviewed row, not on a ${p.status} row`,
    });
  }
  if (p.kind === "versioned" && p.aliasTarget !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["aliasTarget"],
      message: "a versioned row has no aliasTarget",
    });
  }
  if (new Set(p.questionTypes).size !== p.questionTypes.length) {
    ctx.addIssue({ code: "custom", path: ["questionTypes"], message: "must not repeat a question type" });
  }
}

export const ModelProfile = z.strictObject(modelProfileShape).superRefine(checkModelProfile);
export type ModelProfile = z.infer<typeof ModelProfile>;
export type ModelProfileInput = z.input<typeof ModelProfile>;

/**
 * One item of `model.list`: a ModelProfile plus whether it is the
 * calling org's default model. Built from the shape, since zod v4 cannot extend a refined object.
 */
export const ModelListItem = z
  .strictObject({ ...modelProfileShape, isDefault: z.boolean() })
  .superRefine(checkModelProfile);
export type ModelListItem = z.infer<typeof ModelListItem>;

// ---------------------------------------------------------------------------
// Pinned or moving

export const ModelPinning = z.enum(["pinned", "moving"]);
export type ModelPinning = z.infer<typeof ModelPinning>;

/** True only for a registry row of kind `versioned`. A missing row is moving. */
export function isPinnedProfile(profile: Pick<ModelProfile, "kind"> | null | undefined): boolean {
  return profile?.kind === "versioned";
}

/**
 * Classify a model name against registry rows by exact id. Never inferred from the shape of the
 * name: `jev-1.13` or an unseen `foo-2.0.0` is moving because no versioned row has that id.
 */
export function classifyModelName(
  name: string,
  profiles: Iterable<Pick<ModelProfile, "id" | "kind">>,
): ModelPinning {
  for (const p of profiles) {
    if (p.id === name) return isPinnedProfile(p) ? "pinned" : "moving";
  }
  return "moving";
}

// ---------------------------------------------------------------------------
// Routes: the same model through another provider

const NullablePositiveInt = PositiveInt.nullable();

/**
 * A provider's own limits for a model. Null means the provider publishes none, and the profile's
 * value applies. OpenRouter lists Jev with a 32,000 token context for state plus questions.
 */
export const RouteLimits = z
  .strictObject({
    requestTokens: NullablePositiveInt,
    statePlusLongestQuestionTokens: NullablePositiveInt,
    rpm: NullablePositiveInt,
    tokensPerSec: NullablePositiveInt,
  })
  .refine(
    (l) =>
      l.requestTokens === null ||
      l.statePlusLongestQuestionTokens === null ||
      l.statePlusLongestQuestionTokens <= l.requestTokens,
    { path: ["statePlusLongestQuestionTokens"], message: "must not exceed requestTokens" },
  );
export type RouteLimits = z.infer<typeof RouteLimits>;

/**
 * One row of `system_one_model_routes`: how one registry model is reached through one provider.
 * `typesafe` is the identity route and needs no row. For any other provider, a missing row means
 * the model is not reachable there.
 */
export const ModelRoute = z
  .strictObject({
    /** The registry id (ModelProfile.id), for example "jev-1.13.0". */
    modelId: z.string().min(1),
    provider: SystemOneProvider,
    /** The id we send, for example "typesafe/jev-1.13" or "~typesafe/jev-latest". */
    providerModelId: z.string().min(1),
    /**
     * True only when providerModelId names exactly one build, so a set on this route may pass
     * shadow. It also needs the profile to be versioned. OpenRouter's "typesafe/jev-1.13" answers
     * with dated builds, so its seed row is false until a dated id is confirmed as a request id.
     */
    pinned: z.boolean(),
    /**
     * Response `model` values accepted as this registry model, for example
     * "typesafe/jev-1.13-20260917". A response outside this list on a pinned route is drift.
     */
    resolvedIds: z.array(z.string().min(1)),
    limits: RouteLimits,
    /** The provider's model page. */
    docsUrl: z.url(),
    /** YYYY-MM-DD: the date a human checked the row against the provider's docs. */
    lastReviewed: IsoDate,
  })
  .refine((r) => r.provider !== "typesafe", {
    path: ["provider"],
    message: "typesafe is the identity route and has no row",
  })
  .refine((r) => new Set(r.resolvedIds).size === r.resolvedIds.length, {
    path: ["resolvedIds"],
    message: "must not repeat an id",
  });
export type ModelRoute = z.infer<typeof ModelRoute>;
export type ModelRouteInput = z.input<typeof ModelRoute>;

/** What a call on one provider uses: the id to send, whether it is pinned, and the limits. */
export interface EffectiveRoute {
  provider: SystemOneProvider;
  providerModelId: string;
  pinned: boolean;
  /** Null only when the profile is unreviewed. Preflight reads these, never profile.limits. */
  limits: ModelLimits | null;
}

function tighter(profileValue: number, routeValue: number | null): number {
  return routeValue === null ? profileValue : Math.min(profileValue, routeValue);
}

/** The profile's limits, each tightened by the route's value when the route sets one. */
export function effectiveLimits(profile: ModelLimits | null, route: RouteLimits | null): ModelLimits | null {
  if (profile === null) return null;
  if (route === null) return profile;
  return {
    requestTokens: tighter(profile.requestTokens, route.requestTokens),
    statePlusLongestQuestionTokens: Math.min(
      tighter(profile.statePlusLongestQuestionTokens, route.statePlusLongestQuestionTokens),
      tighter(profile.requestTokens, route.requestTokens),
    ),
    rpm: tighter(profile.rpm, route.rpm),
    tokensPerSec: tighter(profile.tokensPerSec, route.tokensPerSec),
  };
}

/**
 * Resolve how a profile is called on a provider. Null when the provider is not typesafe and no
 * route row exists, which the caller reports as model_unavailable.
 */
export function resolveRoute(
  profile: Pick<ModelProfile, "id" | "kind" | "limits">,
  provider: SystemOneProvider,
  routes: Iterable<ModelRoute>,
): EffectiveRoute | null {
  if (provider === "typesafe") {
    return {
      provider,
      providerModelId: defaultProviderModelId(provider, profile.id, profile.kind),
      pinned: isPinnedProfile(profile),
      limits: profile.limits,
    };
  }
  for (const r of routes) {
    if (r.modelId === profile.id && r.provider === provider) {
      return {
        provider,
        providerModelId: r.providerModelId,
        pinned: isPinnedProfile(profile) && r.pinned,
        limits: effectiveLimits(profile.limits, r.limits),
      };
    }
  }
  return null;
}

/**
 * Map a response `model` back to a registry id. TypeSafe answers with registry ids, so they pass
 * through. For another provider, the route whose resolvedIds (or providerModelId) holds the value
 * wins; null when no route knows it, which the run records as a `model_resolved_unmapped` warning.
 */
export function registryIdForResolved(
  provider: SystemOneProvider,
  responseModel: string,
  routes: Iterable<ModelRoute>,
): string | null {
  if (provider === "typesafe") return responseModel;
  for (const r of routes) {
    if (r.provider !== provider) continue;
    if (r.resolvedIds.includes(responseModel) || r.providerModelId === responseModel) return r.modelId;
  }
  return null;
}
