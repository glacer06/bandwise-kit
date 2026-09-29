// Redaction for what a hook sends to System One. Hook state is Claude Code's own input:
// prompts, commands and file contents, which can carry secrets. Only the fields the spec's input
// schema names are sent, strings are cut to the schema's maxLength, and secret-shaped text is
// replaced before the call.

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk_live_|sk_test_|pk_live_|rk_live_|sa_live_)[A-Za-z0-9_-]+/g,
  /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // NAME=value where the name says it is secret: API_KEY=..., password: ...
  /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi,
];

/** Long opaque tokens with letters and digits mixed. Plain hex (commit ids, hashes) is kept. */
const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Replace secret-shaped text with [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match: string, name?: string, sep?: string) => (typeof name === "string" && typeof sep === "string" ? `${name}${sep}[redacted]` : "[redacted]"));
  }
  return out.replace(OPAQUE, (m) => (/^[0-9a-f]+$/i.test(m) || !/[0-9]/.test(m) || !/[A-Za-z]/.test(m) ? m : "[redacted]"));
}

interface PropertySchema {
  type?: unknown;
  maxLength?: unknown;
}

/**
 * Keep only the fields the input schema names, cut strings to maxLength and redact them. Fields
 * the schema does not name never leave the machine. `drop` removes named fields as well.
 */
export function shapeState(candidate: Readonly<Record<string, unknown>>, inputSchema: unknown, drop: readonly string[] = []): Record<string, unknown> {
  const properties = (typeof inputSchema === "object" && inputSchema !== null ? (inputSchema as { properties?: unknown }).properties : undefined) ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties as Record<string, PropertySchema>)) {
    if (drop.includes(name)) continue;
    const value = candidate[name];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const max = typeof schema.maxLength === "number" ? schema.maxLength : 4000;
      const redacted = redactSecrets(value);
      out[name] = redacted.length > max ? redacted.slice(0, max) : redacted;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[name] = value;
    }
  }
  return out;
}
