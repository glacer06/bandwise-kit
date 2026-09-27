// HTTP status to Bandwise error code.
// It reads the status only, never the body: OpenRouter's error body differs from TypeSafe's, and
// provider messages must not reach a caller. Shared by the SDK transport and the fixture transport,
// so it lives in the fixture folder, which never imports the SDK.

import { ERROR_CODES, type ErrorCode, TransportError, type SystemOneProvider } from "@bandwise/core";

/** The Bandwise code for a System One HTTP status on either provider. */
export function systemOneCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 422:
      return "system_one_invalid_request";
    case 401:
    case 402: // OpenRouter: insufficient credits. Not retryable; the key stays active.
      return "system_one_auth";
    case 403:
      return "system_one_forbidden";
    case 404:
      return "model_unavailable";
    case 429:
      return "system_one_rate_limited";
    case 529:
      return "system_one_overloaded";
    default:
      if (status === 408 || status >= 500) return "system_one_unavailable";
      return "system_one_invalid_request";
  }
}

/** A scrubbed TransportError for a status. The message names the status and provider only. */
export function transportErrorForStatus(status: number, provider: SystemOneProvider, requestId: string | null): TransportError {
  const code = systemOneCodeForStatus(status);
  return new TransportError(
    { code, retryable: ERROR_CODES[code].retryable, requestId },
    `System One request to ${provider} failed with HTTP ${status}`,
  );
}
