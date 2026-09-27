
import { describe, expect, it } from "vitest";

import {
  EVENT_DATA,
  EVENT_SUBJECT_TYPES,
  EVENT_TYPES,
  EventEnvelope,
  EventType,
  PLATFORM_EVENT_TYPES,
  TENANT_EVENT_TYPES,
  isPlatformEventType,
  parseEventData,
} from "./events.js";

const ORG = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f60";
const SET = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f61";
const V1 = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f62";
const V2 = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f63";
const USER = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f64";
const TOKEN = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f65";
const EVENT = "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f66";

const published = {
  id: EVENT,
  type: "set.published",
  orgId: ORG,
  occurredAt: "2026-09-26T12:00:00Z",
  actor: { type: "agent", userId: USER, tokenId: TOKEN, client: "cli" },
  subject: { type: "set", id: SET },
  data: {
    channel: "production",
    version: 8,
    versionId: V2,
    fromVersionId: V1,
    interfaceMajor: 2,
    interfaceHash: "sha256:4f1c9e",
    changelog: "Tighter urgency thresholds",
    source: "cli",
  },
};

describe("EventType", () => {
  it("is the union of the tenant and platform catalogs", () => {
    expect(EventType.options).toEqual([...TENANT_EVENT_TYPES, ...PLATFORM_EVENT_TYPES]);
    expect(TENANT_EVENT_TYPES).toHaveLength(23);
    expect(PLATFORM_EVENT_TYPES).toEqual(["contract.changed", "model.unreviewed"]);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("has a data schema and subject list for every type", () => {
    for (const t of EVENT_TYPES) {
      expect(EVENT_DATA[t]).toBeDefined();
      expect(EVENT_SUBJECT_TYPES[t].length).toBeGreaterThan(0);
    }
  });

  it("classifies platform-only types", () => {
    expect(isPlatformEventType("contract.changed")).toBe(true);
    expect(isPlatformEventType("set.published")).toBe(false);
  });
});

describe("EventEnvelope", () => {
  it("parses a set.published event and round-trips", () => {
    const parsed = EventEnvelope.parse(published);
    expect(parsed).toEqual(published);
    expect(EventEnvelope.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects an unknown event type", () => {
    expect(EventEnvelope.safeParse({ ...published, type: "set.deleted" }).success).toBe(false);
  });

  it("checks data against the schema for its type", () => {
    const result = EventEnvelope.safeParse({ ...published, data: { ...published.data, channel: "canary" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["data", "channel"]);
  });

  it("checks the subject type against the catalog", () => {
    const result = EventEnvelope.safeParse({ ...published, subject: { type: "model", id: SET } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["subject", "type"]);
  });

  it("requires orgId for tenant events and null for platform-only events", () => {
    expect(EventEnvelope.safeParse({ ...published, orgId: null }).success).toBe(false);
    const platform = {
      ...published,
      type: "model.unreviewed",
      orgId: null,
      actor: { type: "system", client: "job" },
      subject: { type: "model", id: "jev-1.14.0" },
      data: { modelId: "jev-1.14.0", seenVia: "observation" },
    };
    expect(EventEnvelope.safeParse(platform).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...platform, orgId: ORG }).success).toBe(false);
  });

  it("drops unknown data fields on typed parse", () => {
    const data = parseEventData("set.published", { ...published.data, state: { email: "secret" } });
    expect(data).not.toHaveProperty("state");
  });
});

describe("event data", () => {
  it("model.available lists candidate sets and marks the cross-family ones", () => {
    const OTHER = "01923f40-0000-7aaa-9bbb-0000000000e9";
    const data = {
      modelId: "jev-2.0.0",
      family: "jev",
      status: "stable",
      releaseDate: "2026-10-01",
      candidateSetIds: [SET, OTHER],
      crossFamilySetIds: [OTHER],
    };
    expect(parseEventData("model.available", data)).toEqual(data);
    expect(() => parseEventData("model.available", { ...data, candidateSetIds: [SET] })).toThrow();
    const { crossFamilySetIds: _omit, ...legacy } = data;
    expect(() => parseEventData("model.available", { ...legacy, pinnedSetsInFamily: [SET] })).toThrow();
  });

  it("accepts dismissed review.resolved with a null resolution", () => {
    const data = {
      setId: SET,
      runId: null,
      externalRef: null,
      decisionId: "category",
      kind: "label",
      status: "dismissed",
      resolution: null,
    };
    expect(parseEventData("review.resolved", data)).toEqual(data);
    expect(() => parseEventData("review.resolved", { ...data, status: "open" })).toThrow();
  });

  it("carries an optional failure class on a review resolution", () => {
    const data = {
      setId: SET,
      runId: null,
      externalRef: null,
      decisionId: "category",
      kind: "action",
      status: "resolved",
      resolution: { value: "billing", execute: false, failureClass: "missing_evidence" },
    };
    expect(parseEventData("review.resolved", data)).toEqual(data);
    const bad = { ...data, resolution: { ...data.resolution, failureClass: "bad_luck" } };
    expect(() => parseEventData("review.resolved", bad)).toThrow();
  });

  it("raises the set_silent liveness alert", () => {
    const data = { kind: "set_silent", severity: "critical", message: "No decisions on production for 15 minutes.", metrics: { windowMinutes: 15, runs: 0 } };
    expect(parseEventData("alert.raised", data)).toEqual(data);
    expect(() => parseEventData("alert.raised", { ...data, kind: "silent" })).toThrow();
  });

  it("raises the escalation_over_budget alert", () => {
    const data = {
      kind: "escalation_over_budget",
      severity: "warning",
      message: "Escalation spend today is $12.40, over the $10.00 daily budget.",
      metrics: { escalationCostMicroUsd: 12_400_000, budgetMicroUsdPerDay: 10_000_000, escalations: 310 },
    };
    expect(parseEventData("alert.raised", data)).toEqual(data);
    expect(() => parseEventData("alert.raised", { ...data, kind: "over_budget" })).toThrow();
  });

  it("types rollout.auto_demoted rules", () => {
    const data = { channel: "production", from: "full", to: "controlled", rule: "band_drift", metrics: { psi: 0.31 } };
    expect(parseEventData("rollout.auto_demoted", data)).toEqual(data);
    expect(() => parseEventData("rollout.auto_demoted", { ...data, rule: "manual" })).toThrow();
  });

  it("carries gate results in rollout.gate_met", () => {
    const data = {
      channel: "production",
      stage: "shadow",
      nextStage: "controlled",
      gates: [{ id: "shadow_runs", required: 200, actual: 240, met: true }],
    };
    expect(parseEventData("rollout.gate_met", data)).toEqual(data);
  });

  it("bounds experiment samplePct to 0..1", () => {
    const data = {
      setId: SET,
      channel: "production",
      kind: "version",
      championVersionId: V1,
      challengerVersionId: V2,
      samplePct: 0.1,
    };
    expect(parseEventData("experiment.started", data)).toEqual(data);
    expect(() => parseEventData("experiment.started", { ...data, samplePct: 10 })).toThrow();
  });

  it("accepts an expired approval without a decider", () => {
    expect(parseEventData("approval.decided", { opId: "set.publish", status: "expired" })).toEqual({
      opId: "set.publish",
      status: "expired",
    });
  });

  it("requires a four-character key suffix", () => {
    expect(() => parseEventData("key.invalid", { keyLast4: "abcde", reason: "401" })).toThrow();
  });
});
