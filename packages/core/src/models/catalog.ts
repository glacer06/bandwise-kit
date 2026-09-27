// Seed rows for the System One model registry (`system_one_models`) and its price book row.
// Facts checked against docs.typesafe.ai
// and openapi.json 0.2.0 on 2026-09-26. The live docs win: when they change, update this file and
// the seed table in the same PR.
//
// Tests and the table seed read these rows. Runtime code reads profiles through the ModelCatalog
// port, never from this file. Catalog data may say Jev; code identifiers stay neutral.

import {
  KNOWN_WEAKNESS_IDS,
  ModelProfile,
  type ModelProfileInput,
  ModelRoute,
  type ModelRouteInput,
} from "../contracts/models.js";
import type { ModelPrice } from "../contracts/ports.js";

const DOCS_URL = "https://docs.typesafe.ai/models.md";
const LAST_REVIEWED = "2026-09-26";

/** jev-1.13.0: the only versioned row, so the only pinned one. */
const VERSIONED_ROW: ModelProfileInput = {
  id: "jev-1.13.0",
  family: "jev",
  kind: "versioned",
  aliasTarget: null,
  status: "stable",
  // Stays null until the platform admin confirms it: GET /v1/models reports dates for aliases only.
  releaseDate: null,
  retireAt: null,
  questionTypes: ["noul", "choice", "score"],
  limits: {
    requestTokens: 64_000,
    statePlusLongestQuestionTokens: 32_000,
    rpm: 1_200,
    tokensPerSec: 250_000,
  },
  // English is the strongest language. Language strength is not a profile field; see the seed notes.
  inputModalities: ["text"],
  weaknesses: [...KNOWN_WEAKNESS_IDS],
  supersedes: [],
  docsUrl: DOCS_URL,
  jaggednessUrl: "https://docs.typesafe.ai/model-jaggedness/jev-1.13.md",
  lastReviewed: LAST_REVIEWED,
};

/**
 * Alias rows copy the target's limits, question types, input modalities and weaknesses only to stay
 * valid rows with non-null limits. ModelCatalog never uses them for a moving name; it uses the
 * profile of the observed target.
 */
function aliasOf(id: string, status: "stable" | "preview", target: ModelProfileInput): ModelProfileInput {
  return {
    id,
    family: target.family,
    kind: "alias",
    aliasTarget: target.id,
    status,
    releaseDate: null,
    retireAt: null,
    questionTypes: [...target.questionTypes],
    limits: target.limits === null ? null : { ...target.limits },
    inputModalities: [...target.inputModalities],
    weaknesses: [...target.weaknesses],
    supersedes: [],
    docsUrl: DOCS_URL,
    jaggednessUrl: null,
    lastReviewed: LAST_REVIEWED,
  };
}

const SEED_INPUT: readonly ModelProfileInput[] = [
  VERSIONED_ROW,
  aliasOf("jev-latest", "stable", VERSIONED_ROW),
  // TypeSafe says jev-preview moves ahead of jev-latest when a preview build exists. None exists today.
  aliasOf("jev-preview", "preview", VERSIONED_ROW),
];

/** Seed ModelProfile rows, parsed at load so a bad edit fails loudly. */
export const SEED_MODEL_PROFILES: readonly ModelProfile[] = Object.freeze(
  SEED_INPUT.map((row) => ModelProfile.parse(row)),
);

/**
 * OpenRouter route rows. Facts from OpenRouter's Jev pages and
 * Models API on 2026-09-26: `typesafe/jev-1.13` and `~typesafe/jev-latest`, a 32,000 token context
 * for state plus questions, and responses from the dated build `typesafe/jev-1.13-20260917`.
 * OpenRouter publishes no per-model rpm or tokens-per-second, so those stay null.
 *
 * Neither row is pinned. `typesafe/jev-1.13` answers with dated builds, and whether OpenRouter
 * accepts a dated id as a request model is not confirmed. Sets on OpenRouter stay in inactive or
 * shadow until it is.
 */
const OPENROUTER_LIMITS = {
  requestTokens: 32_000,
  statePlusLongestQuestionTokens: 32_000,
  rpm: null,
  tokensPerSec: null,
} as const;

const SEED_ROUTE_INPUT: readonly ModelRouteInput[] = [
  {
    modelId: "jev-1.13.0",
    provider: "openrouter",
    providerModelId: "typesafe/jev-1.13",
    pinned: false,
    resolvedIds: ["typesafe/jev-1.13-20260917"],
    limits: { ...OPENROUTER_LIMITS },
    docsUrl: "https://openrouter.ai/typesafe/jev-1.13",
    lastReviewed: LAST_REVIEWED,
  },
  {
    modelId: "jev-latest",
    provider: "openrouter",
    providerModelId: "~typesafe/jev-latest",
    pinned: false,
    // An alias: its observed target is tracked in model_alias_observations, not here.
    resolvedIds: [],
    limits: { ...OPENROUTER_LIMITS },
    docsUrl: "https://openrouter.ai/typesafe",
    lastReviewed: LAST_REVIEWED,
  },
  // Vercel AI Gateway, checked on 2026-09-27 against Vercel's "TypeSafe API with AI
  // Gateway" page. It documents one id, `typesafe-ai/jev`, and no versioned id, so jev-1.13.0 has
  // no Vercel row and this row is not pinned. Sets on Vercel stay in inactive or shadow until a
  // versioned id is confirmed. Vercel publishes no limits of its own, so the profile's apply.
  {
    modelId: "jev-latest",
    provider: "vercel",
    providerModelId: "typesafe-ai/jev",
    pinned: false,
    resolvedIds: [],
    limits: { requestTokens: null, statePlusLongestQuestionTokens: null, rpm: null, tokensPerSec: null },
    docsUrl: "https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe",
    lastReviewed: "2026-09-27",
  },
];

/** Seed ModelRoute rows, parsed at load so a bad edit fails loudly. */
export const SEED_MODEL_ROUTES: readonly ModelRoute[] = Object.freeze(
  SEED_ROUTE_INPUT.map((row) => ModelRoute.parse(row)),
);

/** Seed value of the platform setting `defaultModel`: a stable versioned id (section 14). */
export const SEED_PLATFORM_DEFAULT_MODEL = "jev-1.13.0";

/** A platform `price_books` row (org_id null), keyed by exact model id. */
export interface SeedModelPrice extends ModelPrice {
  model: string;
}

/**
 * Platform price rows. Prices are not part of a ModelProfile. jev-1.13.0 costs
 * $0.042 per million input tokens (42,000 micro-USD) and output is currently free; the zero is
 * data, not an assumption.
 */
export const SEED_SYSTEM_ONE_PRICES: readonly SeedModelPrice[] = Object.freeze([
  { model: "jev-1.13.0", inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 },
]);

/**
 * Platform comparator price rows: the provider's exact model ids.
 * Haiku 4.5 is the seeded default comparator and the one the example spec names. Prices are from
 * the documented seed table (Every newsletter, 2026-09-23); confirm them against the vendors'
 * pricing pages before the first customer report. The Gemini row waits for Google's exact id.
 */
export const SEED_COMPARATOR_PRICES: readonly SeedModelPrice[] = Object.freeze([
  { model: "claude-haiku-4-5", inputPerMtokMicroUsd: 1_000_000, outputPerMtokMicroUsd: 5_000_000 },
  { model: "claude-fable-5-1", inputPerMtokMicroUsd: 10_000_000, outputPerMtokMicroUsd: 50_000_000 },
]);

/** Seed value of the org default comparator. */
export const SEED_DEFAULT_COMPARATOR_MODEL = "claude-haiku-4-5";
