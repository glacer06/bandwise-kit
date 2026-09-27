// Helpers the lint rules share.

import type { LintResult, QuestionSetSpec } from "../contracts/spec.js";
import type { QuestionDef } from "../contracts/question-types.js";
import { backtickPaths, stringsIn } from "../util/state-path.js";

export interface QuestionEntry {
  id: string;
  stageIndex: number;
  question: QuestionDef;
  /** JSON Pointer of the question in the spec. */
  path: string;
}

/** JSON Pointer segment escaping (RFC 6901). */
export const seg = (s: string | number): string => String(s).replaceAll("~", "~0").replaceAll("/", "~1");

export function questionEntries(spec: QuestionSetSpec): QuestionEntry[] {
  return spec.stages.flatMap((stage, stageIndex) =>
    Object.entries(stage.questions).map(([id, question]) => ({
      id,
      stageIndex,
      question,
      path: `/stages/${stageIndex}/questions/${seg(id)}`,
    })),
  );
}

/** All the text of a question's instructions (and criteria when asked), joined. */
export function textOf(value: unknown): string {
  return stringsIn(value).join(" ");
}

/**
 * Backtick state paths a question reads, from its instructions and criteria. A path whose root is a
 * key of an object instruction names that field, not state (docs.typesafe.ai/api.md), so it is
 * left out.
 */
export function statePathsOf(q: QuestionDef): string[] {
  const own =
    q.instructions !== null && typeof q.instructions === "object" && !Array.isArray(q.instructions)
      ? new Set(Object.keys(q.instructions))
      : new Set<string>();
  const paths = [...stringsIn(q.instructions), ...stringsIn(q.criteria)].flatMap((t) => backtickPaths(t));
  return [...new Set(paths)].filter((p) => !own.has(rootOf(p)));
}

/** The first segment of a state path. */
export function rootOf(path: string): string {
  return path.split(/[.[]/)[0] ?? path;
}

/** A lint finding. */
export function finding(rule: string, severity: "error" | "warning", path: string, message: string): LintResult {
  return { rule, severity, path, message };
}

/** Word count of a text. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
