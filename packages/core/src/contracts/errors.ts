// Error envelope v2, ErrorDetail and GateResult.
// Response shapes use z.object, so a field added later in v1 is dropped on parse, not rejected.

import { z } from "zod";

import { RunId, Scope } from "./common.js";
import { LintSeverity, type LintResult } from "./spec.js";

// ---------------------------------------------------------------------------
// ErrorDetail and GateResult

/**
 * One item of `error.details`. The same shape as a lint result (`LintResult` in spec.ts), so
 * `draft.validate`, `422 spec_invalid` and `400 invalid_request` all return it as is.
 */
export const ErrorDetail = z.object({
  /** JSON Pointer into the request body or the spec. */
  path: z.string(),
  /** Stable rule id, for example a lint rule id such as `model.alias_past_shadow`. Never renamed. */
  rule: z.string().min(1),
  severity: LintSeverity,
  message: z.string(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

/** One item of `error.gates`, of `DryRunResult.gates` and of the `rollout.get` gate list. */
export const GateResult = z.object({
  /** Stable gate id. */
  id: z.string().min(1),
  /** What the gate needs, for example `0.95` or `{ "minLabeledHigh": 250 }`. */
  required: z.json(),
  /**
   * What was measured. Below the label minimum a gate is never met, and `actual` carries the
   * string `"insufficient_data"`.
   */
  actual: z.json(),
  met: z.boolean(),
});
export type GateResult = z.infer<typeof GateResult>;

// ---------------------------------------------------------------------------
// Error codes

/** HTTP status and retry signal for every code in the documented table. */
export const ERROR_CODES = {
  invalid_state: { status: 400, retryable: false },
  invalid_request: { status: 400, retryable: false },
  unauthenticated: { status: 401, retryable: false },
  quota_exceeded: { status: 402, retryable: false },
  token_budget_exceeded: { status: 402, retryable: false },
  insufficient_scope: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  already_exists: { status: 409, retryable: false },
  gate_not_met: { status: 409, retryable: false },
  interface_mismatch: { status: 409, retryable: false },
  set_not_live: { status: 409, retryable: false },
  precondition_failed: { status: 412, retryable: false },
  preflight_too_large: { status: 413, retryable: false },
  spec_invalid: { status: 422, retryable: false },
  idempotency_key_reused: { status: 422, retryable: false },
  model_unavailable: { status: 422, retryable: false },
  model_unpriced: { status: 422, retryable: false },
  precondition_required: { status: 428, retryable: false },
  rate_limited: { status: 429, retryable: true },
  system_one_rate_limited: { status: 429, retryable: true },
  system_one_invalid_request: { status: 502, retryable: false },
  system_one_invalid_response: { status: 502, retryable: false },
  system_one_forbidden: { status: 502, retryable: false },
  system_one_unavailable: { status: 503, retryable: true },
  system_one_overloaded: { status: 503, retryable: true },
  system_one_auth: { status: 503, retryable: false },
} as const satisfies Record<string, { status: number; retryable: boolean }>;

type ErrorCodeName = keyof typeof ERROR_CODES;

export const ErrorCode = z.enum(Object.keys(ERROR_CODES) as [ErrorCodeName, ...ErrorCodeName[]]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ---------------------------------------------------------------------------
// Envelope

/**
 * The `error` object. `code` stays a plain string on the wire so a client built against an older
 * contract still parses a code added later in v1; producers use `ErrorCode`.
 */
export const ErrorBody = z.object({
  code: z.string().min(1),
  message: z.string(),
  requestId: z.string().min(1),
  retryable: z.boolean(),
  details: z.array(ErrorDetail).optional(),
  gates: z.array(GateResult).optional(),
  /** With `403 insufficient_scope`. */
  requiredScope: Scope.optional(),
  /** With `412 precondition_failed`: the draft's current ETag. */
  currentEtag: z.string().min(1).optional(),
  /** Set when a failed run row was written. */
  runId: RunId.optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ErrorEnvelope = z.object({ error: ErrorBody });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export interface ErrorEnvelopeInit {
  message: string;
  requestId: string;
  details?: ErrorDetail[];
  gates?: GateResult[];
  requiredScope?: Scope;
  currentEtag?: string;
  runId?: string;
}

/** Build an envelope for a known code. `retryable` comes from the code table. */
export function errorEnvelope(code: ErrorCode, init: ErrorEnvelopeInit): ErrorEnvelope {
  const error: ErrorBody = {
    code,
    message: init.message,
    requestId: init.requestId,
    retryable: ERROR_CODES[code].retryable,
  };
  if (init.details !== undefined) error.details = init.details;
  if (init.gates !== undefined) error.gates = init.gates;
  if (init.requiredScope !== undefined) error.requiredScope = init.requiredScope;
  if (init.currentEtag !== undefined) error.currentEtag = init.currentEtag;
  if (init.runId !== undefined) error.runId = init.runId;
  return { error };
}

/** HTTP status for a known code. */
export function errorStatus(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

// Compile-time check: a lint result stays usable as an error detail without mapping.
type _AssertTrue<T extends true> = T;
type _LintResultIsErrorDetail = _AssertTrue<LintResult extends ErrorDetail ? true : false>;
