// The evaluation fallback guard. Vercel AI Gateway can rerun an uncertain answer on
// another model, often an LLM, when a request carries `providerOptions.gateway.models`. Bandwise never
// sends providerOptions, so a fallback should never happen. If a response still shows one, it is an
// LLM answer that looks like a System One answer, and banding it would corrupt bands, calibration
// and savings. The client rejects it as system_one_invalid_response.
//
// Shared by the SDK transport and the fixture transport, so it lives in the fixture folder, which
// never imports the SDK. It applies to every provider: a Choice or Score answer with confidence 0
// and no probabilities is never a System One answer.

import { ERROR_CODES, type SystemOneProvider, type SystemOneResponse, TransportError } from "@bandwise/core";

/** The header AI Gateway sets when an evaluation fallback gave the final answer. */
export const EVALUATION_FALLBACK_HEADER = "x-ai-gateway-evaluation-fallback-triggered";

/** Response headers, as a Headers object or a plain record (fixtures). Names match case-insensitively. */
export type HeaderSource = Headers | Readonly<Record<string, string>>;

function hasHeader(headers: HeaderSource | undefined, name: string): boolean {
  if (headers === undefined) return false;
  if (headers instanceof Headers) return headers.has(name);
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/**
 * Why a response is an evaluation fallback, or null when it is a System One answer. Checks the
 * fallback header, then each Choice or Score answer for `confidence: 0` with empty `probabilities`.
 */
export function evaluationFallbackReason(response: SystemOneResponse, headers?: HeaderSource): string | null {
  if (hasHeader(headers, EVALUATION_FALLBACK_HEADER)) return `the ${EVALUATION_FALLBACK_HEADER} header is set`;
  for (const [qid, answer] of Object.entries(response.answers)) {
    if (answer.type !== "choice" && answer.type !== "score") continue;
    const { confidence, probabilities } = answer as { confidence?: unknown; probabilities?: unknown };
    const empty = typeof probabilities === "object" && probabilities !== null && Object.keys(probabilities).length === 0;
    if (confidence === 0 && empty) return `answer ${qid} has confidence 0 and no probabilities`;
  }
  return null;
}

/** Throw system_one_invalid_response when the response is an evaluation fallback. */
export function assertNotEvaluationFallback(
  response: SystemOneResponse,
  provider: SystemOneProvider,
  requestId: string | null,
  headers?: HeaderSource,
): void {
  const reason = evaluationFallbackReason(response, headers);
  if (reason === null) return;
  throw new TransportError(
    { code: "system_one_invalid_response", retryable: ERROR_CODES.system_one_invalid_response.retryable, requestId },
    `System One on ${provider} returned an evaluation fallback answer, which Bandwise does not accept: ${reason}`,
  );
}
