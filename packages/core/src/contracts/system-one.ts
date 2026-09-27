// The System One wire contract: the request body we send and the response we parse.
// Response schemas are loose (passthrough) so fields a newer
// API adds are kept. Runs store the raw answer JSON.

import { z } from "zod";
import { QuestionId, Structured, TokenCount } from "./common.js";
import { QuestionTypeId, isQuestionTypeId } from "./question-types.js";

// ---------------------------------------------------------------------------
// API-wide rules. They hold for every model; per-model limits live in ModelProfile.

export const SYSTEM_ONE_LIMITS = {
  /** Options per choice, at most. */
  maxChoiceOptions: 255,
  /** Score levels, at least. */
  minScoreLevels: 2,
  /** Score levels, at most. */
  maxScoreLevels: 10,
} as const;

// ---------------------------------------------------------------------------
// Providers

/**
 * Who serves a System One call. `typesafe` is TypeSafe's own API. `openrouter` is OpenRouter's
 * System One API and `vercel` is Vercel AI Gateway's TypeSafe API. Both implement
 * TypeSafe's request and response shapes, so the same SDK calls them with a different base URL and
 * the provider's key.
 */
export const SystemOneProvider = z.enum(["typesafe", "openrouter", "vercel"]);
export type SystemOneProvider = z.infer<typeof SystemOneProvider>;

/**
 * The SDK `baseURL` per provider. system-one-client always passes it explicitly, so the SDK's own
 * `TYPESAFE_BASE_URL` fallback can never send an org key somewhere else.
 */
export const SYSTEM_ONE_PROVIDER_BASE_URLS = {
  typesafe: "https://api.typesafe.ai",
  openrouter: "https://openrouter.ai/api",
  vercel: "https://ai-gateway.vercel.sh/typesafe",
} as const satisfies Record<SystemOneProvider, string>;

const OPENROUTER_NAMESPACE = "typesafe/";
const OPENROUTER_ALIAS_NAMESPACE = "~typesafe/";

/**
 * The model id OpenRouter routes a TypeSafe id to, following OpenRouter's documented mapping:
 * `jev-1.13` becomes `typesafe/jev-1.13`, an alias such as `jev-latest` becomes
 * `~typesafe/jev-latest`, and an id that already has an author prefix is used as is. `kind` comes
 * from the registry row, or null when the name has none. Route rows (ModelRoute) hold the id we
 * actually send; this is the default when a row is missing and the seed's cross-check.
 */
export function toOpenRouterModelId(id: string, kind: "versioned" | "alias" | null): string {
  if (id.includes("/")) return id;
  return `${kind === "alias" ? OPENROUTER_ALIAS_NAMESPACE : OPENROUTER_NAMESPACE}${id}`;
}

/**
 * The TypeSafe-style name inside an OpenRouter id: `typesafe/jev-1.13-20260917` becomes
 * `jev-1.13-20260917` and `~typesafe/jev-latest` becomes `jev-latest`. Ids of other authors are
 * returned unchanged. For display and logs; mapping to a registry id uses the route rows
 * (registryIdForResolved in models.ts), because OpenRouter's dated ids are not TypeSafe ids.
 */
export function fromOpenRouterModelId(id: string): string {
  if (id.startsWith(OPENROUTER_ALIAS_NAMESPACE)) return id.slice(OPENROUTER_ALIAS_NAMESPACE.length);
  if (id.startsWith(OPENROUTER_NAMESPACE)) return id.slice(OPENROUTER_NAMESPACE.length);
  return id;
}

const VERCEL_NAMESPACE = "typesafe-ai/";

/**
 * The model id Vercel AI Gateway is asked for. Vercel documents one id,
 * `typesafe-ai/jev`, which serves the moving `jev-latest`. No versioned Vercel id is documented, so
 * any other TypeSafe id only gets the `typesafe-ai/` prefix, and that mapping is unverified. Route
 * rows (ModelRoute) hold the id we actually send and are authoritative; this is the default when a
 * row is missing and the seed's cross-check. An id that already has an author prefix is used as is.
 */
export function toVercelModelId(id: string): string {
  if (id.includes("/")) return id;
  if (id === "jev-latest") return `${VERCEL_NAMESPACE}jev`;
  return `${VERCEL_NAMESPACE}${id}`;
}

/** The id to send for a model on a provider when no route row says otherwise. */
export function defaultProviderModelId(
  provider: SystemOneProvider,
  id: string,
  kind: "versioned" | "alias" | null,
): string {
  switch (provider) {
    case "openrouter":
      return toOpenRouterModelId(id, kind);
    case "vercel":
      return toVercelModelId(id);
    case "typesafe":
      return id;
  }
}

// ---------------------------------------------------------------------------
// Request

/** One entry of `SystemOneRequest.questions`: the API question body a QuestionTypeModule compiles. */
export const SystemOneQuestion = z.strictObject({
  type: QuestionTypeId,
  instructions: Structured,
  /** Noul: `{ true, false }`. Choice: option map. Score: ordered level array. */
  criteria: Structured.optional(),
});
export type SystemOneQuestion = z.infer<typeof SystemOneQuestion>;

/** The body of `POST /v1/systemone`. `state` is a string, a JSON object or an array. */
export const SystemOneRequest = z.strictObject({
  state: z.unknown(),
  model: z.string().min(1),
  questions: z
    .record(QuestionId, SystemOneQuestion)
    .refine((q) => Object.keys(q).length > 0, "questions needs at least one entry"),
});
export type SystemOneRequest = z.infer<typeof SystemOneRequest>;

// ---------------------------------------------------------------------------
// Answers

export const NoulAnswer = z.looseObject({
  type: z.literal("noul"),
  /** Probability of yes, 0 to 1. Near 0.5 means equally likely, not medium intensity. */
  noul: z.number(),
});
export type NoulAnswer = z.infer<typeof NoulAnswer>;

export const ChoiceAnswer = z.looseObject({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;

export const ScoreAnswer = z.looseObject({
  type: z.literal("score"),
  /** Probability weighted; can land between levels. */
  score: z.number(),
  legend: z.record(z.string(), Structured),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;

/**
 * An answer whose `type` no question-type module knows. Every other field is kept as sent. The refine
 * matters: a known type that fails its own variant stays a parse error instead of passing as unknown.
 */
export const UnknownAnswer = z.looseObject({
  type: z.string().refine((t) => !isQuestionTypeId(t), "a known answer type must match its own variant"),
});
export type UnknownAnswer = z.infer<typeof UnknownAnswer>;

export const KnownAnswer = z.discriminatedUnion("type", [NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type KnownAnswer = z.infer<typeof KnownAnswer>;

/** A union with a fallthrough branch, so a new answer type is stored raw instead of failing the run. */
export const SystemOneAnswer = z.union([KnownAnswer, UnknownAnswer]);
export type SystemOneAnswer = z.infer<typeof SystemOneAnswer>;

/** True when core has a module for this answer's type. */
export function isKnownAnswer(answer: SystemOneAnswer): answer is KnownAnswer {
  return isQuestionTypeId(answer.type);
}

// ---------------------------------------------------------------------------
// Response

export const SystemOneUsage = z.looseObject({
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  /**
   * USD the provider charged for this request. OpenRouter sends it; TypeSafe direct does not
   * today. When present it is the call's actual cost and the price book is the fallback.
   */
  cost: z.number().nonnegative().optional(),
});
export type SystemOneUsage = z.infer<typeof SystemOneUsage>;

/**
 * What Vercel AI Gateway adds under `provider_metadata.gateway`. Only `cost` is read: the
 * USD charge for the request, sent as a decimal string such as "0.00001155". The other documented
 * fields (`marketCost`, `gatewayCost`, routing fields, `generationId`) are kept as sent.
 */
export const SystemOneGatewayMetadata = z.looseObject({
  cost: z.string().min(1).optional(),
});
export type SystemOneGatewayMetadata = z.infer<typeof SystemOneGatewayMetadata>;

export const SystemOneProviderMetadata = z.looseObject({
  gateway: SystemOneGatewayMetadata.optional(),
});
export type SystemOneProviderMetadata = z.infer<typeof SystemOneProviderMetadata>;

export const SystemOneResponse = z.looseObject({
  /** OpenRouter's generation id (`gen-dec-...`). The request id when no x-typesafe-request-id header came back. */
  id: z.string().min(1).optional(),
  /**
   * The id that answered, even when the request sent an alias. Stored as model_resolved. TypeSafe
   * sends its versioned id; OpenRouter sends its own id, for example `typesafe/jev-1.13-20260917`.
   */
  model: z.string().min(1),
  /** The upstream provider name OpenRouter reports, for example "TypeSafe". Not a SystemOneProvider. */
  provider: z.string().min(1).optional(),
  answers: z.record(z.string(), SystemOneAnswer),
  usage: SystemOneUsage,
  /** Vercel AI Gateway's metadata. `gateway.cost` is the provider-reported cost there. */
  provider_metadata: SystemOneProviderMetadata.optional(),
});
export type SystemOneResponse = z.infer<typeof SystemOneResponse>;
