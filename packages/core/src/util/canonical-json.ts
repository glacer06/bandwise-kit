// Canonical JSON: object keys sorted, no whitespace. Hashes of state, specs and requests use it,
// so the same value always gives the same hash whatever the key order.

import { sha256Hex } from "./sha256.js";

/** JSON text with object keys sorted at every level. `undefined` members are dropped, as JSON does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text: string | undefined = JSON.stringify(value);
    return text === undefined ? "null" : text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 hex of the canonical JSON of a value. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
