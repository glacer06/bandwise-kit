// Text for the remote commands: one line per error with what to do next, the approval notice,
// and short JSON previews for diffs.

import type { ApiError } from "./client.js";
import { unquoteEtag } from "./client.js";
import { BASE_URL_ENV, TOKEN_ENV } from "./credentials.js";

/** Exit codes. */
export const EXIT = { ok: 0, error: 1, diff: 2, approval: 3 } as const;

function hint(e: ApiError): string | null {
  switch (e.code) {
    case "unauthenticated":
      return `check ${TOKEN_ENV}: the token is wrong, expired or revoked`;
    case "insufficient_scope":
      return e.requiredScope !== null ? `the token needs the ${e.requiredScope} scope` : "the token lacks the scope or role for this";
    case "not_found":
      return "check the set slug. A set outside the token's allowlist also reads as not found";
    case "precondition_failed":
      return `the draft changed on the server${e.currentEtag !== null ? ` (now ${unquoteEtag(e.currentEtag)})` : ""}. Run bandwise spec diff, merge, then push again`;
    case "precondition_required":
      return "the draft ETag is missing. Pull the draft or pass --if-match";
    case "network_error":
    case "timeout":
      return `check ${BASE_URL_ENV} and your connection`;
    default:
      return null;
  }
}

/** The error as text: one line, then each detail and gate, then a hint. */
export function formatApiError(e: ApiError): string {
  const status = e.status !== null ? ` (HTTP ${e.status})` : "";
  const request = e.requestId !== null ? ` [request ${e.requestId}]` : "";
  const lines = [`error ${e.code}${status}: ${e.message || "no message"}${request}`];
  for (const d of e.details) lines.push(`  ${d.severity ?? "error"} ${d.rule} at ${d.path || "/"}: ${d.message}`);
  for (const g of e.gates) lines.push(`  gate ${g.id}: ${g.met ? "met" : "not met"} (required ${preview(g.required)}, actual ${preview(g.actual)})`);
  const h = hint(e);
  if (h !== null) lines.push(`  ${h}`);
  return lines.join("\n");
}

/** A short one-line JSON preview of a value. */
export function preview(value: unknown, max = 80): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
