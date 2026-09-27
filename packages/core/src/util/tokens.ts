// Token estimates for preflight, lints and the savings counterfactual. There is no tokenizer in
// core, so the estimate is the UTF-8 byte length of the JSON text divided by 4, rounded up. It
// errs high for English text, which keeps preflight on the safe side of the model limits.

import { canonicalJson } from "./canonical-json.js";
import { utf8Length } from "./sha256.js";

export const BYTES_PER_TOKEN = 4;

/** Estimated tokens of a value as it would be sent: a string as is, anything else as JSON. */
export function estimateTokens(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === "string" ? value : canonicalJson(value);
  return Math.ceil(utf8Length(text) / BYTES_PER_TOKEN);
}
