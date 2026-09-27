import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { microFromUsd, RunResult } from "./run.js";
import { DEFAULT_LABELING_POLICY } from "./learning.js";
import {
  Approval,
  AuditAppendInput,
  AuditRow,
  DEFAULT_GATE_MARGINS,
  GateMargins,
  MovePointerInput,
  parseSetRef,
  Pointer,
  ResolvedSetRef,
  ReviewItem,
  ReviewResolveInput,
  RunListFilter,
  RunRecord,
  RunRecordSource,
  SetRecord,
  SetRolloutStageInput,
  ValueSettings,
  VersionRecord,
} from "./stores.js";

const ORG = "01923f40-0000-7aaa-9bbb-000000000001";
const USER = "01923f40-0000-7aaa-9bbb-0000000000a1";
const TOKEN = "01923f40-0000-7aaa-9bbb-0000000000b1";
const PROJECT = "01923f40-0000-7aaa-9bbb-0000000000f1";
const NOW = "2026-09-26T12:00:00Z";

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as unknown;
}

const result = RunResult.parse(readJson("./__fixtures__/run-result.sample.json"));
const exampleSpec = readJson("../../../../examples/email-triage.spec.json");

/** The runs row for the sample RunResult, per the mapping table. */
function rowFromResult(r: RunResult): unknown {
  const calls = r.stages.flatMap((s) => s.calls);
  return {
    id: r.runId,
    orgId: ORG,
    projectId: PROJECT,
    setId: r.setId,
    versionId: r.versionId,
    channel: r.channel,
    rollout: r.rollout,
    experimentId: null,
    arm: null,
    parentRunId: null,
    source: "api",
    appId: null,
    actorUserId: null,
    actorTokenId: null,
    keyMode: "byo",
    modelRequested: r.modelRequested,
    modelResolved: r.modelResolved,
    typesafeRequestId: r.typesafeRequestId,
    interfaceMajor: r.interfaceMajor,
    externalRef: "msg_8812",
    state: { email: { subject: "Re: contract" } },
    stateHash: "sha256:ab12",
    stages: r.stages,
    checks: r.checks,
    answers: r.answers,
    decisions: r.decisions,
    runBand: r.runBand,
    overallAction: r.overallAction,
    route: r.route,
    warnings: r.warnings,
    inputTokens: r.cost.systemOneInputTokens,
    outputTokens: r.cost.systemOneOutputTokens,
    systemOneCostMicroUsd: r.cost.systemOneCostUsd === null ? null : microFromUsd(r.cost.systemOneCostUsd),
    systemOneCalls: calls.length,
    cfInputTokens: r.cost.counterfactualInputTokens,
    cfOutputTokens: r.cost.counterfactualOutputTokens,
    counterfactualMicroUsd: microFromUsd(r.cost.counterfactualLlmCostUsd),
    counterfactualMode: r.cost.counterfactualMode,
    comparatorModel: r.cost.comparatorModel,
    savingsMicroUsd: microFromUsd(r.cost.savingsUsd),
    savingsKind: r.cost.savingsKind,
    savingsSuppressed: r.cost.savingsSuppressed,
    escalationCostMicroUsd: microFromUsd(r.cost.escalationCostUsd),
    llmCallsMade: r.cost.llmCallsMade,
    llmCallsAvoided: r.cost.llmCallsAvoided,
    contextTokensPruned: null,
    latencyMs: r.cost.latencyMs,
    status: r.status,
    errorCode: null,
    createdAt: NOW,
  };
}

describe("RunRecord", () => {
  it("holds the sample run with integer micro-USD money columns", () => {
    const row = RunRecord.parse(rowFromResult(result));
    expect(row.systemOneCostMicroUsd).toBe(13);
    expect(row.counterfactualMicroUsd).toBe(1218);
    expect(row.savingsMicroUsd).toBe(1205);
    expect(row.savingsMicroUsd).toBe(row.counterfactualMicroUsd - 13 - row.escalationCostMicroUsd);
  });

  it("keeps checks and the parent run, so replay and linked runs survive the state purge", () => {
    const row = rowFromResult(result) as Record<string, unknown>;
    const parsed = RunRecord.parse({ ...row, state: null, checks: { has_body: true }, parentRunId: result.runId });
    expect(parsed.checks).toEqual({ has_body: true });
    expect(parsed.parentRunId).toBe(result.runId);
    const { checks: _checks, ...withoutChecks } = row;
    expect(RunRecord.safeParse(withoutChecks).success).toBe(false);
    const { parentRunId: _parent, ...withoutParent } = row;
    expect(RunRecord.safeParse(withoutParent).success).toBe(false);
  });

  it("rejects float money columns", () => {
    const row = rowFromResult(result) as Record<string, unknown>;
    expect(RunRecord.safeParse({ ...row, savingsMicroUsd: 0.001205 }).success).toBe(false);
  });

  it("allows source ingest on rows only", () => {
    expect(RunRecordSource.options).toContain("ingest");
    const row = rowFromResult(result) as Record<string, unknown>;
    expect(RunRecord.safeParse({ ...row, source: "ingest" }).success).toBe(true);
    expect(RunRecord.safeParse({ ...row, source: "webhook" }).success).toBe(false);
  });

  it("list filters are strict", () => {
    expect(RunListFilter.safeParse({ setId: result.setId, band: "high", source: "cli" }).success).toBe(true);
    expect(RunListFilter.safeParse({ orgId: ORG }).success).toBe(false);
  });
});

describe("versions and pointers", () => {
  it("parses a published version row holding the example spec", () => {
    const row = {
      id: result.versionId,
      orgId: ORG,
      setId: result.setId,
      version: 7,
      status: "published",
      spec: exampleSpec,
      specHash: "sha256:aa",
      interfaceHash: result.interfaceHash,
      interfaceMajor: 2,
      model: "jev-1.13.0",
      changelog: "Tighten category thresholds",
      source: "cli",
      sourceRef: "4f1c9a7",
      createdByUserId: USER,
      createdByTokenId: TOKEN,
      publishedByUserId: USER,
      publishedByTokenId: TOKEN,
      publishedAt: NOW,
      evalRunId: null,
    };
    expect(VersionRecord.safeParse(row).success).toBe(true);
    expect(VersionRecord.safeParse({ ...row, spec: { ...(exampleSpec as object), rollout: "full" } }).success).toBe(false);
  });

  it("a pointer holds the rollout stage; only production and staging have one", () => {
    const pointer = {
      orgId: ORG,
      setId: result.setId,
      channel: "production",
      versionId: result.versionId,
      rolloutStage: "controlled",
      activeExperimentId: null,
      updatedAt: NOW,
    };
    expect(Pointer.safeParse(pointer).success).toBe(true);
    expect(Pointer.safeParse({ ...pointer, channel: "draft" }).success).toBe(false);
  });

  it("pointer inputs are strict and typed", () => {
    const move = { setId: result.setId, channel: "staging", toVersionId: result.versionId, kind: "rollback", reason: null, approvalId: null };
    expect(MovePointerInput.safeParse(move).success).toBe(true);
    expect(MovePointerInput.safeParse({ ...move, kind: "canary" }).success).toBe(false);
    const stage = {
      setId: result.setId,
      channel: "production",
      to: "paused",
      kind: "auto_demote",
      reason: "precision_below_target",
      approvalId: null,
    };
    expect(SetRolloutStageInput.safeParse(stage).success).toBe(true);
    expect(SetRolloutStageInput.safeParse({ ...stage, kind: "publish" }).success).toBe(false);
    // release_events.approval_id: an approved agent operation records its approval.
    const approvalId = "01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e30";
    expect(MovePointerInput.safeParse({ ...move, approvalId }).success).toBe(true);
    expect(SetRolloutStageInput.safeParse({ ...stage, approvalId }).success).toBe(true);
    const { approvalId: _a, ...withoutApproval } = move;
    expect(MovePointerInput.safeParse(withoutApproval).success).toBe(false);
  });
});

describe("review, audit and approvals", () => {
  it("a resolution may carry a failure class", () => {
    const input = { resolution: { value: "billing" }, addToDataset: false, pendingConfirmation: false };
    expect(ReviewResolveInput.parse(input)).toEqual(input);
    expect(ReviewResolveInput.parse({ ...input, failureClass: "code_error" }).failureClass).toBe("code_error");
    expect(ReviewResolveInput.safeParse({ ...input, failureClass: "unknown" }).success).toBe(false);
  });

  it("a review item may wait in pending_confirmation", () => {
    const item = {
      id: "01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e10",
      orgId: ORG,
      runId: result.runId,
      studioExampleId: null,
      setId: result.setId,
      decisionId: "someone_waiting",
      kind: "action",
      reason: "action",
      sampleRate: null,
      band: "medium",
      suggested: { value: true },
      status: "pending_confirmation",
      assigneeId: null,
      resolution: { value: false },
      resolvedByUserId: USER,
      resolvedByTokenId: TOKEN,
      resolvedAt: NOW,
      dueAt: null,
      addToDataset: false,
    };
    expect(ReviewItem.safeParse(item).success).toBe(true);
    expect(ReviewItem.safeParse({ ...item, sampleRate: 0 }).success).toBe(false);
    expect(ReviewItem.safeParse({ ...item, kind: "audit" }).success).toBe(false);
  });

  it("audit rows record the agent token and the effective role", () => {
    const row = {
      id: "01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e20",
      orgId: ORG,
      actorType: "agent",
      client: "mcp",
      actorUserId: USER,
      actorTokenId: TOKEN,
      actorRole: "editor",
      approvalId: null,
      impersonatorId: null,
      action: "set.publish",
      targetType: "set",
      targetId: result.setId,
      diff: { version: 7 },
      ip: null,
      userAgent: null,
      createdAt: NOW,
    };
    expect(AuditRow.safeParse(row).success).toBe(true);
    expect(AuditRow.safeParse({ ...row, actorType: "bot" }).success).toBe(false);
    expect(AuditAppendInput.safeParse({ action: "set.publish", targetType: "set", targetId: "x", diff: null, approvalId: null }).success).toBe(true);
    expect(AuditAppendInput.safeParse({ action: "set.publish", targetType: "set", targetId: "x", diff: null, approvalId: null, actorUserId: USER }).success).toBe(false);
  });

  it("approvals keep the stored input and If-Match", () => {
    const approval = {
      id: "01923f4e-7b2b-7c3d-8e4f-5a6b7c8d9e30",
      orgId: ORG,
      opId: "set.publish",
      input: { setRef: "email-triage", channel: "production" },
      inputHash: "sha256:cd",
      ifMatch: "sha256:aa",
      requestedByTokenId: TOKEN,
      requestedByUserId: USER,
      reason: "Tighten thresholds",
      status: "pending",
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: "2026-10-03T12:00:00Z",
      result: null,
      createdAt: NOW,
    };
    expect(Approval.safeParse(approval).success).toBe(true);
    expect(Approval.safeParse({ ...approval, status: "cancelled" }).success).toBe(false);
  });
});

describe("sets", () => {
  const set = {
    id: result.setId,
    orgId: ORG,
    projectId: PROJECT,
    goalId: "01923f40-0000-7aaa-9bbb-0000000000e1",
    slug: "email-triage",
    name: "Email triage",
    description: null,
    protected: false,
    labeling: DEFAULT_LABELING_POLICY,
    dispatchActionsOnStaging: false,
    valueSettings: { errorCostUsd: 12, reviewCostUsd: 1.5 },
    gateMargins: DEFAULT_GATE_MARGINS,
    storageMode: "hash_only",
    userGenerated: false,
    resultCacheTtlSeconds: null,
    draftVersionId: result.versionId,
    archivedAt: null,
    createdByUserId: USER,
    createdByTokenId: null,
  };

  it("parses a question_sets row, with no rollout column", () => {
    expect(SetRecord.safeParse(set).success).toBe(true);
    expect(SetRecord.safeParse({ ...set, storageMode: "none" }).success).toBe(false);
    expect(SetRecord.parse({ ...set, rolloutStage: "full" })).not.toHaveProperty("rolloutStage");
    expect(ValueSettings.safeParse({ errorCostUsd: -1, reviewCostUsd: 0 }).success).toBe(false);
    expect(GateMargins.safeParse({ coverageDrop: 2, reviewLoadRise: 0 }).success).toBe(false);
  });

  it("parses every {ref} form", () => {
    expect(parseSetRef("email-triage")).toEqual({ set: "email-triage", selector: { kind: "channel" } });
    expect(parseSetRef("email-triage@7")).toEqual({ set: "email-triage", selector: { kind: "version", version: 7 } });
    expect(parseSetRef("email-triage@draft")).toEqual({ set: "email-triage", selector: { kind: "draft" } });
    expect(parseSetRef(result.setId)).toEqual({ set: result.setId, selector: { kind: "channel" } });
    for (const bad of ["", "@7", "slug@0", "slug@07", "slug@latest", "a@1@2", "has space"]) {
      expect(parseSetRef(bad), bad).toBeNull();
    }
  });

  it("a resolved ref carries the row and the selector", () => {
    expect(ResolvedSetRef.safeParse({ set, selector: { kind: "version", version: 7 } }).success).toBe(true);
    expect(ResolvedSetRef.safeParse({ set, selector: { kind: "version", version: 0 } }).success).toBe(false);
  });
});
