import { describe, expect, it } from "vitest";

import {
  DEFAULT_LABELING_POLICY,
  FAILURE_CLASSES,
  FailureClass,
  FEEDBACK_MAX_ITEMS,
  FeedbackBatch,
  FeedbackReport,
  LabelSelection,
  LabelingPolicy,
  QUALITY_TARGET_DEFAULTS,
  QualityTarget,
  SetHealth,
  ThresholdProposal,
  defaultQualityTarget,
} from "./learning.js";

const RUN_ID = "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c0d";

describe("FeedbackReport", () => {
  const byRef = {
    externalRef: "ticket_48213",
    target: { decisionId: "department" },
    observed: "billing",
    observedAt: "2026-09-26T14:02:00Z",
    idempotencyKey: "fb_48213_department",
  };

  it("parses the documented example body", () => {
    expect(FeedbackBatch.parse({ items: [byRef] }).items[0]).toEqual(byRef);
  });

  it("parses a route target matched by runId", () => {
    const item = { ...byRef, externalRef: undefined, runId: RUN_ID, target: { route: true }, observed: "urgent" };
    expect(FeedbackReport.safeParse(item).success).toBe(true);
  });

  it("accepts an optional failure class and rejects an unknown one", () => {
    for (const failureClass of FAILURE_CLASSES) {
      expect(FeedbackReport.safeParse({ ...byRef, failureClass }).success, failureClass).toBe(true);
    }
    expect(FAILURE_CLASSES).toEqual(["missing_evidence", "model_error", "code_error", "service"]);
    expect(FeedbackReport.safeParse({ ...byRef, failureClass: "outage" }).success).toBe(false);
    expect(FailureClass.safeParse("service").success).toBe(true);
  });

  it("accepts observed booleans and score level indexes", () => {
    expect(FeedbackReport.safeParse({ ...byRef, observed: true }).success).toBe(true);
    expect(FeedbackReport.safeParse({ ...byRef, observed: 2 }).success).toBe(true);
  });

  it("requires exactly one of runId or externalRef", () => {
    const neither = { ...byRef, externalRef: undefined };
    expect(FeedbackReport.safeParse(neither).success).toBe(false);
    expect(FeedbackReport.safeParse({ ...byRef, runId: RUN_ID }).success).toBe(false);
  });

  it("requires observed", () => {
    const { observed: _omit, ...rest } = byRef;
    expect(FeedbackReport.safeParse(rest).success).toBe(false);
  });

  it("has no source field: the server derives it, so any body source fails", () => {
    for (const source of ["app", "agent", "reviewer", "audit", "human"]) {
      expect(FeedbackReport.safeParse({ ...byRef, source }).success, source).toBe(false);
    }
  });

  it("is strict and checks the target shape", () => {
    expect(FeedbackReport.safeParse({ ...byRef, note: "x" }).success).toBe(false);
    expect(FeedbackReport.safeParse({ ...byRef, target: { route: false } }).success).toBe(false);
    expect(FeedbackReport.safeParse({ ...byRef, target: { decisionId: "Department" } }).success).toBe(false);
    expect(FeedbackReport.safeParse({ ...byRef, target: { decisionId: "a", route: true } }).success).toBe(false);
  });

  it("rejects a bad timestamp or an empty idempotency key", () => {
    expect(FeedbackReport.safeParse({ ...byRef, observedAt: "2026-09-26" }).success).toBe(false);
    expect(FeedbackReport.safeParse({ ...byRef, idempotencyKey: "" }).success).toBe(false);
  });

  it("takes 1 to 1,000 items per body", () => {
    expect(FeedbackBatch.safeParse({ items: [] }).success).toBe(false);
    expect(FeedbackBatch.safeParse({ items: Array.from({ length: FEEDBACK_MAX_ITEMS }, () => byRef) }).success).toBe(
      true,
    );
    expect(
      FeedbackBatch.safeParse({ items: Array.from({ length: FEEDBACK_MAX_ITEMS + 1 }, () => byRef) }).success,
    ).toBe(false);
  });
});

describe("LabelingPolicy", () => {
  it("parses the documented default", () => {
    expect(LabelingPolicy.parse(DEFAULT_LABELING_POLICY)).toEqual(DEFAULT_LABELING_POLICY);
  });

  it("allows targeted to be omitted and a zero budget", () => {
    expect(LabelingPolicy.safeParse({ dailyBudget: 0, auditRate: { high: 0, medium: 0, low: 0 } }).success).toBe(true);
  });

  it("keeps rates within 0 to 1 and the budget a whole number", () => {
    const base = { dailyBudget: 50, auditRate: { high: 0.02, medium: 0.05, low: 0.02 } };
    expect(LabelingPolicy.safeParse({ ...base, auditRate: { high: 1.2, medium: 0, low: 0 } }).success).toBe(false);
    expect(LabelingPolicy.safeParse({ ...base, dailyBudget: 2.5 }).success).toBe(false);
    expect(LabelingPolicy.safeParse({ ...base, dailyBudget: -1 }).success).toBe(false);
    expect(LabelingPolicy.safeParse({ ...base, auditRate: { high: 0.02, medium: 0.05 } }).success).toBe(false);
  });

  it("rejects targeted shares that add up to more than the budget", () => {
    const r = LabelingPolicy.safeParse({
      ...DEFAULT_LABELING_POLICY,
      targeted: { nearThreshold: 0.7, challengerDisagreement: 0.5 },
    });
    expect(r.success).toBe(false);
  });

  it("is strict", () => {
    expect(LabelingPolicy.safeParse({ ...DEFAULT_LABELING_POLICY, rollout: "full" }).success).toBe(false);
  });
});

describe("LabelSelection", () => {
  it("ties the sample rate to audit picks", () => {
    expect(LabelSelection.safeParse({ select: true, reason: "audit", sampleRate: 0.02 }).success).toBe(true);
    expect(LabelSelection.safeParse({ select: true, reason: "near_threshold", sampleRate: null }).success).toBe(true);
    expect(LabelSelection.safeParse({ select: true, reason: "audit", sampleRate: null }).success).toBe(false);
    expect(LabelSelection.safeParse({ select: true, reason: "challenger_diff", sampleRate: 0.1 }).success).toBe(false);
    expect(LabelSelection.safeParse({ select: false, reason: "audit", sampleRate: null }).success).toBe(true);
  });
});

describe("QualityTarget", () => {
  it("has the normative tier defaults", () => {
    expect(QUALITY_TARGET_DEFAULTS).toEqual({
      low: { tier: "low", highPrecision: 0.9, mediumPrecision: 0.75, minCoverage: 0.6, minLabeledHigh: 50 },
      standard: { tier: "standard", highPrecision: 0.95, mediumPrecision: 0.85, minCoverage: 0.5, minLabeledHigh: 100 },
      high: { tier: "high", highPrecision: 0.98, mediumPrecision: 0.95, minCoverage: 0.3, minLabeledHigh: 250 },
    });
    for (const t of Object.values(QUALITY_TARGET_DEFAULTS)) expect(QualityTarget.safeParse(t).success).toBe(true);
  });

  it("returns a fresh copy of a tier default", () => {
    const t = defaultQualityTarget("standard");
    t.highPrecision = 0.5;
    expect(QUALITY_TARGET_DEFAULTS.standard.highPrecision).toBe(0.95);
  });

  it("rejects out of range values, an unknown tier and extra keys", () => {
    const std = QUALITY_TARGET_DEFAULTS.standard;
    expect(QualityTarget.safeParse({ ...std, highPrecision: 95 }).success).toBe(false);
    expect(QualityTarget.safeParse({ ...std, minLabeledHigh: 99.5 }).success).toBe(false);
    expect(QualityTarget.safeParse({ ...std, tier: "critical" }).success).toBe(false);
    expect(QualityTarget.safeParse({ ...std, successMetric: "x" }).success).toBe(false);
  });
});

describe("SetHealth", () => {
  const metrics = {
    labeledN: 120,
    precision: {
      high: { value: 0.97, lower95: 0.93, labeledN: 100 },
      medium: { value: 0.8, lower95: 0.6, labeledN: 15 },
      low: { value: null, lower95: null, labeledN: 5 },
    },
    coverage: 0.62,
    reviewLoadPerDay: 14.5,
    ece: 0.04,
    psi: { bandMix: 0.05, answers: null },
    stability: null,
    costPerDecisionUsd: 0.0000126,
  };
  const health = {
    setId: "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c0d",
    versionId: "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c0e",
    channel: "production",
    model: "jev-1.13.0",
    status: "below_target",
    flags: ["below_target"],
    target: QUALITY_TARGET_DEFAULTS.standard,
    window: { from: "2026-09-19T00:00:00Z", to: "2026-09-26T00:00:00Z" },
    set: metrics,
    questions: { department: { ...metrics, status: "below_target" } },
  };

  it("parses a health report", () => {
    expect(SetHealth.parse(health)).toEqual(health);
  });

  it("requires every band in precision", () => {
    const { low: _omit, ...twoBands } = metrics.precision;
    expect(SetHealth.safeParse({ ...health, set: { ...metrics, precision: twoBands } }).success).toBe(false);
  });

  it("requires status to be the first flag in the status order", () => {
    expect(SetHealth.safeParse({ ...health, status: "drifting", flags: ["drifting", "below_target"] }).success).toBe(true);
    expect(SetHealth.safeParse({ ...health, status: "below_target", flags: ["drifting", "below_target"] }).success).toBe(
      false,
    );
    expect(SetHealth.safeParse({ ...health, flags: [] }).success).toBe(false);
    expect(SetHealth.safeParse({ ...health, flags: ["below_target", "below_target"] }).success).toBe(false);
  });

  it("does not combine ok with another status", () => {
    expect(SetHealth.safeParse({ ...health, status: "ok", flags: ["ok"] }).success).toBe(true);
    expect(SetHealth.safeParse({ ...health, status: "below_target", flags: ["below_target", "ok"] }).success).toBe(false);
  });

  it("accepts only pointer channels and valid question ids", () => {
    expect(SetHealth.safeParse({ ...health, channel: "draft" }).success).toBe(false);
    expect(SetHealth.safeParse({ ...health, questions: { "Bad-Id": health.questions.department } }).success).toBe(false);
  });

  it("rejects a window that ends before it starts", () => {
    expect(
      SetHealth.safeParse({ ...health, window: { from: "2026-09-26T00:00:00Z", to: "2026-09-19T00:00:00Z" } }).success,
    ).toBe(false);
  });
});

describe("ThresholdProposal", () => {
  const current = {
    type: "choice",
    gating: true,
    thresholds: { high: 0.85, medium: 0.6 },
    actions: {
      high: { kind: "auto" },
      medium: { kind: "review" },
      low: { kind: "fallback" },
    },
  };
  const proposal = {
    decisionId: "department",
    current,
    proposed: { ...current, thresholds: { high: 0.8, medium: 0.55 } },
    curve: [
      { threshold: 0.8, precision: 0.97, precisionLower95: 0.95, coverage: 0.71 },
      { threshold: 0.85, precision: 0.98, precisionLower95: 0.96, coverage: 0.64 },
    ],
    support: 340,
    insufficientData: false,
  };

  it("parses a proposal", () => {
    const r = ThresholdProposal.safeParse(proposal);
    expect(r.error?.issues).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("requires proposed to equal current when data is insufficient", () => {
    expect(ThresholdProposal.safeParse({ ...proposal, insufficientData: true }).success).toBe(false);
    const reordered = {
      actions: current.actions,
      thresholds: { medium: 0.6, high: 0.85 },
      gating: true,
      type: "choice",
    };
    expect(
      ThresholdProposal.safeParse({ ...proposal, insufficientData: true, support: 12, proposed: reordered }).success,
    ).toBe(true);
  });

  it("keeps the policy type", () => {
    const score = { ...current, type: "score" };
    expect(ThresholdProposal.safeParse({ ...proposal, proposed: score }).success).toBe(false);
  });

  it("keeps curve values within 0 to 1", () => {
    const bad = [{ threshold: 0.8, precision: 1.2, precisionLower95: 0.9, coverage: 0.5 }];
    expect(ThresholdProposal.safeParse({ ...proposal, curve: bad }).success).toBe(false);
  });
});
