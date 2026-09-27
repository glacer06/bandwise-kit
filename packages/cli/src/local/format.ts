// Human output for `bandwise run --local`. `--json` prints the RunResult envelope instead.

import type { LintResult, RunResult } from "@bandwise/core";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

const usd = (n: number | null): string => (n === null ? "unpriced" : `$${n.toFixed(6)}`);

/** A short, plain report of one local run. */
export function formatRun(result: RunResult, lints: readonly LintResult[], answersFrom: ReadonlyArray<"fixture" | "synthetic">): string {
  const lines: string[] = [];
  lines.push("bandwise run --local (fixture transport, no network, no key)");
  lines.push(`model ${result.modelRequested} answered by ${result.modelResolved ?? "none"}; rollout ${result.rollout}; status ${result.status}`);
  if (result.error !== undefined) lines.push(`error ${result.error.code}: ${result.error.message}`);
  lines.push(`run band ${result.runBand}; overall action ${result.overallAction}; route ${result.route ?? "none"}`);
  lines.push("");
  lines.push("decisions");
  const width = Math.max(8, ...Object.keys(result.decisions).map((k) => k.length)) + 2;
  for (const [id, d] of Object.entries(result.decisions)) {
    const value = typeof d.value === "number" ? String(Math.round(d.value * 1000) / 1000) : JSON.stringify(d.value);
    const level = d.level === undefined ? "" : ` level ${d.level}`;
    const relevance = d.relevant ? "" : " (not relevant)";
    lines.push(`  ${pad(id, width)}${pad(value, 16)}band ${pad(d.band, 7)}${d.action} -> ${d.effectiveAction}${level}${relevance}`);
  }
  lines.push("");
  const c = result.cost;
  lines.push(`System One cost ${usd(c.systemOneCostUsd)} for ${c.systemOneInputTokens} input tokens`);
  lines.push(
    `estimated savings ${usd(c.savingsUsd)} against ${c.comparatorModel} (${c.counterfactualMode}, ${c.savingsKind}${c.savingsSuppressed === null ? "" : `, suppressed: ${c.savingsSuppressed}`})`,
  );
  const synthetic = answersFrom.filter((a) => a === "synthetic").length;
  lines.push(
    synthetic === 0
      ? `answers from recorded fixtures (${answersFrom.length} call${answersFrom.length === 1 ? "" : "s"})`
      : `answers: ${synthetic} of ${answersFrom.length} calls had no recorded fixture and got synthetic answers. They are not model output.`,
  );
  if (result.warnings.length > 0) lines.push(`warnings: ${result.warnings.join(", ")}`);
  if (lints.length > 0) {
    lines.push("");
    lines.push("lint");
    for (const l of lints) lines.push(`  ${l.severity} ${l.rule} at ${l.path || "/"}: ${l.message}`);
  }
  return lines.join("\n");
}
