// Human output for `bandwise run --live`. `--json` prints the RunResult envelope instead.

import type { RunResult } from "@bandwise/core";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const usd = (n: number | null): string => (n === null ? "unpriced" : `$${n.toFixed(6)}`);

export function formatLiveRun(result: RunResult, note: string): string {
  const lines: string[] = [];
  lines.push(`bandwise run --live (${result.stages[0]?.calls[0]?.provider ?? "no call"}, your own key)`);
  lines.push(`model ${result.modelRequested} answered by ${result.modelResolved ?? "none"}; rollout ${result.rollout}; status ${result.status}`);
  if (result.error !== undefined) lines.push(`error ${result.error.code}: ${result.error.message}`);
  lines.push(`run band ${result.runBand}; overall action ${result.overallAction}; route ${result.route ?? "none"}`);
  lines.push("");
  lines.push("decisions");
  const width = Math.max(8, ...Object.keys(result.decisions).map((k) => k.length)) + 2;
  for (const [id, d] of Object.entries(result.decisions)) {
    const value = typeof d.value === "number" ? String(Math.round(d.value * 1000) / 1000) : JSON.stringify(d.value);
    lines.push(`  ${pad(id, width)}${pad(value, 16)}band ${pad(d.band, 7)}${d.action} -> ${d.effectiveAction}${d.relevant ? "" : " (not relevant)"}`);
  }
  lines.push("");
  const c = result.cost;
  lines.push(`System One cost ${usd(c.systemOneCostUsd)} for ${c.systemOneInputTokens} input tokens; latency ${c.latencyMs} ms`);
  lines.push(`counterfactual ${usd(c.counterfactualLlmCostUsd)} on ${c.comparatorModel}; savings ${usd(c.savingsUsd)}${c.savingsSuppressed === null ? "" : ` (suppressed: ${c.savingsSuppressed})`}`);
  if (result.warnings.length > 0) lines.push(`warnings: ${result.warnings.join(", ")}`);
  if (note !== "") lines.push(note);
  return lines.join("\n");
}
