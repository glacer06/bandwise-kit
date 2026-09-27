// Effectiveness loop contracts: truth, labeling, quality targets, health and threshold proposals.

import { z } from "zod";

import {
  Band,
  DecisionId,
  IsoTimestamp,
  JsonValue,
  PointerChannel,
  RunId,
  SetId,
  VersionId,
} from "./common.js";
import { ConfidencePolicy } from "./policy.js";

const unit = z.number().min(0).max(1);
const count = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Truth sources

/** `run_feedback.source`. The server derives it from the caller; FeedbackReport has no source field. */
export const FeedbackSource = z.enum(["app", "reviewer", "audit", "agent"]);
export type FeedbackSource = z.infer<typeof FeedbackSource>;

/**
 * Why a decision was wrong. Set by the resolver of
 * a feedback report or a review item. Proposals and set health group misses by it.
 */
export const FAILURE_CLASSES = ["missing_evidence", "model_error", "code_error", "service"] as const;
export const FailureClass = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClass>;

/** One decision, or the run's route. */
export const FeedbackTarget = z.union([
  z.strictObject({ decisionId: DecisionId }),
  z.strictObject({ route: z.literal(true) }),
]);
export type FeedbackTarget = z.infer<typeof FeedbackTarget>;

/**
 * One item of `POST /api/v1/feedback` (1 to 1,000 per body). Matched to a run by exactly one of
 * `runId` or `externalRef`, and idempotent on its own `idempotencyKey`.
 *
 * There is no `source` field. The server derives
 * `run_feedback.source` from the caller: `app` for an `sk_` token, `agent` for an agent token.
 * The schema is strict, so a body that sends `source` fails with `400 invalid_request`.
 */
export const FeedbackReport = z
  .strictObject({
    runId: RunId.optional(),
    externalRef: z.string().min(1).optional(),
    target: FeedbackTarget,
    /** Option key, boolean, score level index, composite level or route output. */
    observed: JsonValue,
    observedAt: IsoTimestamp,
    idempotencyKey: z.string().min(1),
    /** Optional failure class when the report disputes the decision. */
    failureClass: FailureClass.optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.runId === undefined) === (f.externalRef === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: f.runId === undefined ? ["runId"] : ["externalRef"],
        message: "send exactly one of runId or externalRef",
      });
    }
  });
export type FeedbackReport = z.infer<typeof FeedbackReport>;

export const FEEDBACK_MAX_ITEMS = 1000;

/** The `POST /api/v1/feedback` body. */
export const FeedbackBatch = z.strictObject({
  items: z.array(FeedbackReport).min(1).max(FEEDBACK_MAX_ITEMS),
});
export type FeedbackBatch = z.infer<typeof FeedbackBatch>;

// ---------------------------------------------------------------------------
// Labeling policy

/** Why the sampler picked a decision. Only `audit` picks carry a sample rate and count toward gates. */
export const LabelReason = z.enum(["audit", "near_threshold", "challenger_diff"]);
export type LabelReason = z.infer<typeof LabelReason>;

/**
 * `question_sets.labeling`. Changed through `set.update`, never through the spec. Active in every
 * rollout stage on the production channel.
 */
export const LabelingPolicy = z
  .strictObject({
    /** Label items per set per day. 0 turns the audit off (and flags "no truth source"). */
    dailyBudget: count,
    /** Random share per band, 0 to 1. */
    auditRate: z.strictObject({ high: unit, medium: unit, low: unit }),
    /** Shares of what is left of the budget after audit picks. */
    targeted: z.strictObject({ nearThreshold: unit, challengerDisagreement: unit }).optional(),
  })
  .refine((p) => p.targeted === undefined || p.targeted.nearThreshold + p.targeted.challengerDisagreement <= 1, {
    path: ["targeted"],
    message: "targeted shares must not add up to more than 1",
  });
export type LabelingPolicy = z.infer<typeof LabelingPolicy>;

export const DEFAULT_LABELING_POLICY = {
  dailyBudget: 50,
  auditRate: { high: 0.02, medium: 0.05, low: 0.02 },
  targeted: { nearThreshold: 0.2, challengerDisagreement: 0.2 },
} as const satisfies LabelingPolicy;

/** What `selectForLabeling` returns for one relevant decision. */
export const LabelSelection = z
  .strictObject({
    select: z.boolean(),
    reason: LabelReason,
    /** The rate the audit actually used; null for targeted picks. */
    sampleRate: unit.nullable(),
  })
  .refine((s) => !s.select || (s.reason === "audit") === (s.sampleRate !== null), {
    path: ["sampleRate"],
    message: "audit picks carry a sampleRate and targeted picks do not",
  });
export type LabelSelection = z.infer<typeof LabelSelection>;

// ---------------------------------------------------------------------------
// Quality targets

export const QualityTier = z.enum(["low", "standard", "high"]);
export type QualityTier = z.infer<typeof QualityTier>;

/** `goals.quality_target`. The only place precision targets are defined. */
export const QualityTarget = z.strictObject({
  tier: QualityTier,
  highPrecision: unit,
  mediumPrecision: unit,
  minCoverage: unit,
  /** Raw count of labeled high-band decisions below which a gate returns insufficient_data. */
  minLabeledHigh: count,
});
export type QualityTarget = z.infer<typeof QualityTarget>;

/** Tier defaults, the normative table (Quality targets). */
export const QUALITY_TARGET_DEFAULTS = {
  low: { tier: "low", highPrecision: 0.9, mediumPrecision: 0.75, minCoverage: 0.6, minLabeledHigh: 50 },
  standard: { tier: "standard", highPrecision: 0.95, mediumPrecision: 0.85, minCoverage: 0.5, minLabeledHigh: 100 },
  high: { tier: "high", highPrecision: 0.98, mediumPrecision: 0.95, minCoverage: 0.3, minLabeledHigh: 250 },
} as const satisfies { [T in QualityTier]: QualityTarget & { tier: T } };

/** A fresh copy of the defaults for a tier. */
export function defaultQualityTarget(tier: QualityTier): QualityTarget {
  return { ...QUALITY_TARGET_DEFAULTS[tier] };
}

// ---------------------------------------------------------------------------
// Set health

/** Health statuses in priority order: `status` is the first that applies. */
export const HEALTH_STATUS_ORDER = [
  "no_truth_source",
  "drifting",
  "insufficient_data",
  "below_target",
  "ok",
] as const;

export const HealthStatus = z.enum(HEALTH_STATUS_ORDER);
export type HealthStatus = z.infer<typeof HealthStatus>;

/** PSI above this on the band mix or the answer distribution means `drifting`. */
export const HEALTH_DRIFT_PSI = 0.2;

export const BandPrecision = z.strictObject({
  value: unit.nullable(),
  /** 95 percent Wilson lower bound. Gates and health use this, not `value`. */
  lower95: unit.nullable(),
  labeledN: count,
});
export type BandPrecision = z.infer<typeof BandPrecision>;

const healthMetricsShape = {
  labeledN: count,
  /** Every band is present. */
  precision: z.record(Band, BandPrecision),
  coverage: unit,
  reviewLoadPerDay: z.number().nonnegative(),
  /** From the latest eval. */
  ece: unit.nullable(),
  /** Against the baseline: the first 14 days after the version's last promotion on the channel. */
  psi: z.strictObject({
    bandMix: z.number().nonnegative().nullable(),
    answers: z.number().nonnegative().nullable(),
  }),
  /** From the latest eval with repeats. */
  stability: unit.nullable(),
  /**
   * An average over decisions, so it is a USD rate for display rather than stored money, and it
   * can fall below one micro-USD. Totals stay integer micro-USD elsewhere.
   */
  costPerDecisionUsd: z.number().nonnegative(),
};

export const HealthMetrics = z.strictObject(healthMetricsShape);
export type HealthMetrics = z.infer<typeof HealthMetrics>;

export const QuestionHealth = z.strictObject({ ...healthMetricsShape, status: HealthStatus });
export type QuestionHealth = z.infer<typeof QuestionHealth>;

function healthRank(s: HealthStatus): number {
  return HEALTH_STATUS_ORDER.indexOf(s);
}

/** `GET /api/v1/sets/{ref}/health`. No single 0 to 100 score. */
export const SetHealth = z
  .strictObject({
    setId: SetId,
    versionId: VersionId,
    channel: PointerChannel,
    model: z.string().min(1),
    status: HealthStatus,
    /** Every status that applies. `status` is the first of them in HEALTH_STATUS_ORDER. */
    flags: z.array(HealthStatus),
    target: QualityTarget,
    window: z.strictObject({ from: IsoTimestamp, to: IsoTimestamp }),
    set: HealthMetrics,
    questions: z.record(DecisionId, QuestionHealth),
  })
  .superRefine((h, ctx) => {
    if (new Set(h.flags).size !== h.flags.length) {
      ctx.addIssue({ code: "custom", path: ["flags"], message: "must not repeat a status" });
    }
    if (!h.flags.includes(h.status)) {
      ctx.addIssue({ code: "custom", path: ["flags"], message: "must include status" });
    }
    if (h.flags.some((f) => healthRank(f) < healthRank(h.status))) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "must be the first flag in the status order" });
    }
    if (h.flags.includes("ok") && h.flags.length > 1) {
      ctx.addIssue({ code: "custom", path: ["flags"], message: "ok applies only when nothing else does" });
    }
    if (Date.parse(h.window.from) > Date.parse(h.window.to)) {
      ctx.addIssue({ code: "custom", path: ["window"], message: "from must not be after to" });
    }
  });
export type SetHealth = z.infer<typeof SetHealth>;

// ---------------------------------------------------------------------------
// Threshold proposals

export const ThresholdCurvePoint = z.strictObject({
  threshold: unit,
  precision: unit,
  precisionLower95: unit,
  coverage: unit,
});
export type ThresholdCurvePoint = z.infer<typeof ThresholdCurvePoint>;

/** Structural equality of two JSON-like values, ignoring object key order. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (keys.length !== bKeys.length) return false;
  return keys.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]));
}

/**
 * What `suggestThresholds` returns per decision. `proposed` is `current` with threshold fields
 * changed only; below the target's label minimum `insufficientData` is true and `proposed`
 * equals `current`.
 */
export const ThresholdProposal = z
  .strictObject({
    decisionId: DecisionId,
    current: ConfidencePolicy,
    proposed: ConfidencePolicy,
    curve: z.array(ThresholdCurvePoint),
    /** Labeled decisions behind the curve. */
    support: count,
    insufficientData: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.proposed.type !== p.current.type) {
      ctx.addIssue({ code: "custom", path: ["proposed", "type"], message: "must match the current policy type" });
    }
    if (p.insufficientData && !jsonEqual(p.proposed, p.current)) {
      ctx.addIssue({
        code: "custom",
        path: ["proposed"],
        message: "must equal current when insufficientData is true",
      });
    }
  });
export type ThresholdProposal = z.infer<typeof ThresholdProposal>;
