
import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  ErrorCode,
  ErrorDetail,
  ErrorEnvelope,
  GateResult,
  errorEnvelope,
  errorStatus,
} from "./errors.js";
import { parseSpec } from "./spec.js";

const REQ = "req_01J0000000000000000000000";

describe("ErrorEnvelope", () => {
  it("parses the documented preflight example", () => {
    const body = {
      error: {
        code: "preflight_too_large",
        message: "State plus longest question is 41,200 tokens; jev-1.13.0 allows 32,000.",
        requestId: REQ,
        retryable: false,
      },
    };
    expect(ErrorEnvelope.parse(body)).toEqual(body);
  });

  it("parses the documented spec_invalid example with details", () => {
    const body = {
      error: {
        code: "spec_invalid",
        message: "The spec failed 1 lint.",
        requestId: REQ,
        retryable: false,
        details: [
          {
            path: "/model",
            rule: "model.alias_past_shadow",
            severity: "error",
            message: "jev-latest is a moving model. Pin a versioned model before controlled.",
          },
        ],
      },
    };
    expect(ErrorEnvelope.parse(body)).toEqual(body);
  });

  it("carries gates, requiredScope, currentEtag and runId", () => {
    const body = {
      error: {
        code: "gate_not_met",
        message: "1 gate failed.",
        requestId: REQ,
        retryable: false,
        gates: [{ id: "high_precision_lower95", required: 0.95, actual: "insufficient_data", met: false }],
        requiredScope: "release:production",
        currentEtag: "sha256:abc",
        runId: "0190a5f4-3c1e-7d2a-9b4f-2a1c3d4e5f60",
      },
    };
    expect(ErrorEnvelope.parse(body)).toEqual(body);
  });

  it("keeps an unknown code (additive in v1) and drops unknown fields", () => {
    const parsed = ErrorEnvelope.parse({
      error: { code: "new_code_later", message: "m", requestId: REQ, retryable: true, extra: 1 },
    });
    expect(parsed.error.code).toBe("new_code_later");
    expect(parsed.error).not.toHaveProperty("extra");
  });

  it("rejects missing required fields and a bad scope", () => {
    expect(ErrorEnvelope.safeParse({ error: { code: "x", message: "m", requestId: REQ } }).success).toBe(false);
    expect(
      ErrorEnvelope.safeParse({
        error: { code: "x", message: "m", requestId: REQ, retryable: false, requiredScope: "sets:delete" },
      }).success,
    ).toBe(false);
  });
});

describe("ErrorDetail and GateResult", () => {
  it("rejects an unknown severity", () => {
    expect(ErrorDetail.safeParse({ path: "", rule: "r", severity: "info", message: "m" }).success).toBe(false);
  });

  it("accepts spec parse failures as details unchanged", () => {
    const result = parseSpec({ rollout: "full" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const d of result.details) expect(ErrorDetail.parse(d)).toEqual(d);
    }
  });

  it("requires met to be a boolean", () => {
    expect(GateResult.safeParse({ id: "g", required: 1, actual: 1 }).success).toBe(false);
    expect(GateResult.safeParse({ id: "g", required: { min: 200 }, actual: 12, met: false }).success).toBe(true);
  });
});

describe("error codes", () => {
  it("covers every code in the documented table with its status", () => {
    expect(ErrorCode.options).toHaveLength(26);
    expect(errorStatus("insufficient_scope")).toBe(403);
    expect(errorStatus("precondition_failed")).toBe(412);
    expect(errorStatus("preflight_too_large")).toBe(413);
    expect(errorStatus("precondition_required")).toBe(428);
    expect(errorStatus("system_one_auth")).toBe(503);
  });

  it("marks only rate limits and System One overload or outage as retryable", () => {
    const retryable = Object.entries(ERROR_CODES)
      .filter(([, v]) => v.retryable)
      .map(([k]) => k)
      .sort();
    expect(retryable).toEqual([
      "rate_limited",
      "system_one_overloaded",
      "system_one_rate_limited",
      "system_one_unavailable",
    ]);
  });

  it("uses neutral system_one names", () => {
    for (const code of ErrorCode.options) expect(code).not.toMatch(/jev/);
  });

  it("builds an envelope with retryable from the table", () => {
    const env = errorEnvelope("rate_limited", { message: "slow down", requestId: REQ });
    expect(env).toEqual({ error: { code: "rate_limited", message: "slow down", requestId: REQ, retryable: true } });
    expect(ErrorEnvelope.parse(env)).toEqual(env);
    const scoped = errorEnvelope("insufficient_scope", {
      message: "needs sets:write",
      requestId: REQ,
      requiredScope: "sets:write",
    });
    expect(scoped.error.requiredScope).toBe("sets:write");
    expect(scoped.error).not.toHaveProperty("details");
  });
});
