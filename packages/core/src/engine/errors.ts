// What runQuestionSet throws before a run row exists: invalid state, an inactive channel, an
// interface mismatch, an unavailable or unpriced model, or a stage too large for the model.
// Route adapters map it to the documented error envelope with errorEnvelope(code, ...).

import type { ErrorCode } from "../contracts/errors.js";
import type { ErrorDetail } from "../contracts/errors.js";

const BRAND = "bandwise.run_refused";

export class RunRefusedError extends Error {
  override readonly name = "RunRefusedError";
  readonly brand = BRAND;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
  }
}

/** True for a RunRefusedError, including one from another copy of this module. */
export function isRunRefusedError(e: unknown): e is RunRefusedError {
  return typeof e === "object" && e !== null && (e as { brand?: unknown }).brand === BRAND;
}

/** Generic messages per failure code. Provider messages never reach a caller. */
export const RUN_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  system_one_auth: "The org's System One key was rejected.",
  system_one_forbidden: "The org's System One key cannot use this model.",
  system_one_invalid_request: "System One rejected the request.",
  system_one_invalid_response: "System One returned an answer Bandwise cannot use.",
  system_one_rate_limited: "System One rate limited the request.",
  system_one_overloaded: "System One is overloaded.",
  system_one_unavailable: "System One did not answer in time.",
  model_unavailable: "The model is not available.",
  preflight_too_large: "A stage is too large for the model.",
  rate_limited: "The run was rate limited.",
  quota_exceeded: "The plan quota is used up.",
  token_budget_exceeded: "The token's daily spend cap is used up.",
};

export function runErrorMessage(code: ErrorCode): string {
  return RUN_ERROR_MESSAGES[code] ?? "The run failed.";
}
