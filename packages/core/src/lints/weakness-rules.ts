// Model weakness lints. Each fires only when the target
// model's profile lists the weakness id, so a newer model that drops a weakness silences it.

import type { ModelProfile } from "../contracts/models.js";
import type { LintResult, QuestionSetSpec } from "../contracts/spec.js";
import { finding, questionEntries, rootOf, statePathsOf, textOf } from "./helpers.js";

const COUNTING = /\b(how many|count|counts|counting|number of|total|sum|add up)\b/i;
const DATE_WORDS = /\b(before|after|earlier than|later than|older than|newer than|within \d+ (days?|weeks?|months?|hours?))\b/i;
const DATE_PATH = /(date|_at$|_on$|time|deadline|due|expires?|timestamp)/i;
const NEGATIVE = /^\s*(no|not|never|none|nothing|nobody|no one)\b|\b(is not|isn't|does not|doesn't|did not|didn't|was not|wasn't|cannot|can't)\b/i;
const DOUBLE_NEGATIVE = /\bnot\b[^.?!]*\b(not|no|never|without)\b|\bnot un\w+/i;
const GENERATION = /\b(extract|generate|write|rewrite|summari[sz]e|compose|draft|list all|what is the (name|title|value|amount|date))\b/i;
/** Top-level fields at least this long (maxLength) count as large. */
const LARGE_STRING = 2_000;

/** The weakness lints the profile turns on. */
export function weaknessLints(spec: QuestionSetSpec, profile: ModelProfile | null): LintResult[] {
  if (profile === null) return [];
  const has = (id: string): boolean => profile.weaknesses.includes(id);
  const out: LintResult[] = [];
  const entries = questionEntries(spec);

  for (const { id, question, path } of entries) {
    const text = textOf(question.instructions);
    if ((has("counting") || has("arithmetic")) && COUNTING.test(text)) {
      out.push(finding("weakness.counting", "warning", `${path}/instructions`, `"${id}" asks the model to count or add; ask one noul per item and do the sum in code`));
    }
    if (has("date_comparison") && DATE_WORDS.test(text) && statePathsOf(question).some((p) => DATE_PATH.test(p))) {
      out.push(finding("weakness.date_comparison", "warning", `${path}/instructions`, `"${id}" compares dates; extract date parts with choices and compare in code`));
    }
    if (has("inverted_noul") && question.type === "noul") {
      const trueText = textOf(question.criteria?.true);
      if ((trueText !== "" && NEGATIVE.test(trueText)) || DOUBLE_NEGATIVE.test(text)) {
        out.push(finding("weakness.inverted_noul", "warning", `${path}/criteria`, `"${id}" words its true criterion negatively; word it positively`));
      }
    }
    if (has("generation") && question.type !== "choice" && GENERATION.test(text)) {
      out.push(finding("weakness.generation", "warning", `${path}/instructions`, `"${id}" asks for a value with no candidate list; ask a choice over candidates`));
    }
  }

  if (has("large_irrelevant_state")) {
    const referenced = new Set(entries.flatMap((e) => statePathsOf(e.question).map(rootOf)));
    const props = spec.input.schema["properties"];
    if (props !== null && typeof props === "object" && !Array.isArray(props)) {
      for (const [key, sub] of Object.entries(props)) {
        if (referenced.has(key) || sub === null || typeof sub !== "object" || Array.isArray(sub)) continue;
        const s = sub as Record<string, unknown>;
        const large =
          s["type"] === "object" ||
          s["type"] === "array" ||
          (s["type"] === "string" && (typeof s["maxLength"] !== "number" || s["maxLength"] >= LARGE_STRING));
        if (large) {
          out.push(
            finding("weakness.large_unreferenced_state", "warning", `/input/schema/properties/${key}`, `no question reads "${key}"; filter it out in code or the adapter`),
          );
        }
      }
    }
  }

  if (has("structural_invariants")) {
    const nouls = Object.values(spec.policies).filter((p) => p.type === "noul");
    for (const [key, p] of Object.entries(spec.policies)) {
      if (p.type !== "choice" && p.type !== "score") continue;
      const copied = nouls.some(
        (n) => n.type === "noul" && p.thresholds.high === n.noul.trueAt && Math.abs(p.thresholds.medium - (n.noul.trueAt - n.noul.reviewMargin)) < 1e-9,
      );
      if (copied) {
        out.push(finding("weakness.threshold_copied", "warning", `/policies/${key}/thresholds`, `"${key}" reuses a noul's thresholds; tune each question on its own labels`));
      }
    }
  }
  return out;
}
