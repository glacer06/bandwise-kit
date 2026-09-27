// Deterministic synthetic answers for requests no fixture covers (`bandwise run --local` on a spec of
// your own). They are shaped like real answers so the whole run path works, but they are not model
// output: the same request always gets the same numbers, derived from a hash of it.

import {
  type SystemOneAnswer,
  type SystemOneQuestion,
  type SystemOneRequest,
  type SystemOneResponse,
  canonicalJson,
  estimateTokens,
  sha256Hex,
} from "@bandwise/core";

/** A stream of numbers in [0, 1) from a seed, by chained SHA-256. */
function unitStream(seed: string): () => number {
  let block = sha256Hex(seed);
  let offset = 0;
  return () => {
    if (offset + 8 > block.length) {
      block = sha256Hex(block);
      offset = 0;
    }
    const n = parseInt(block.slice(offset, offset + 8), 16);
    offset += 8;
    return n / 0x100000000;
  };
}

/** Probabilities over n outcomes, skewed so one usually stands out, rounded to 4 places. */
function distribution(next: () => number, n: number): number[] {
  const weights = Array.from({ length: n }, () => next() ** 4 + 1e-6);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((w / total) * 1e4) / 1e4);
}

/** 1 minus normalized entropy: 1 when one outcome has all the mass, 0 when all are equal. */
function concentration(p: readonly number[]): number {
  if (p.length < 2) return 1;
  const h = -p.reduce((s, x) => (x > 0 ? s + x * Math.log(x) : s), 0);
  return Math.round((1 - h / Math.log(p.length)) * 1e4) / 1e4;
}

function answerFor(q: SystemOneQuestion, next: () => number): SystemOneAnswer {
  if (q.type === "noul") return { type: "noul", noul: Math.round(next() * 1e4) / 1e4 };
  if (q.type === "choice") {
    const options = q.criteria !== null && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
    const p = distribution(next, options.length);
    const top = p.indexOf(Math.max(...p));
    return {
      type: "choice",
      choice: options[top] ?? "",
      confidence: concentration(p),
      probabilities: Object.fromEntries(options.map((o, i) => [o, p[i] ?? 0])),
    };
  }
  const levels = Array.isArray(q.criteria) ? q.criteria : [];
  const p = distribution(next, levels.length);
  const score = Math.round(p.reduce((s, x, i) => s + x * i, 0) * 1e4) / 1e4;
  return {
    type: "score",
    score,
    confidence: concentration(p),
    legend: Object.fromEntries(levels.map((l, i) => [String(i), l as string])),
    probabilities: Object.fromEntries(p.map((x, i) => [String(i), x])),
  };
}

/** A response for any request, deterministic in the request. `model` is the id that "answered". */
export function syntheticResponse(req: SystemOneRequest, model: string): SystemOneResponse {
  const seed = canonicalJson({ model: req.model, state: req.state });
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [qid, q] of Object.entries(req.questions)) answers[qid] = answerFor(q, unitStream(`${seed}:${qid}:${canonicalJson(q)}`));
  return {
    model,
    answers,
    usage: { input_tokens: estimateTokens(req), output_tokens: 2 * Object.keys(req.questions).length },
  };
}
