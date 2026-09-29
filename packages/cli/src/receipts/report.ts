// `bandwise report [--since 7d] [--set <slug>] [--receipts <path>] [--json]`: sums the local
// receipts per set. Decisions, band mix, what the sets would have done, System One spend, the
// counterfactual LLM spend and the estimated savings. Claude Code figures are estimates: the
// counterfactual is one comparator call per decision from the price book, not a measured bill.

import type { Band, Receipt } from "./receipt.js";

export interface SetReport {
  set: string;
  runs: number;
  /** Runs that ended with an error or a timeout. */
  failed: number;
  decisions: number;
  bands: Record<Band, number>;
  /** Runs whose policy would have acted (overallAction auto and a route) if the set were live. */
  wouldAct: number;
  /** Runs where the hook changed the session. Zero in shadow. */
  acted: number;
  rollouts: string[];
  systemOneCostUsd: number;
  /** Runs with no System One cost (a model with no price row). */
  unpriced: number;
  counterfactualLlmCostUsd: number;
  /** Counterfactual minus System One spend, over every ok run, shadow included. An estimate. */
  estimatedSavingsUsd: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export interface Report {
  since: string | null;
  from: string | null;
  to: string | null;
  sets: SetReport[];
  totals: { runs: number; systemOneCostUsd: number; counterfactualLlmCostUsd: number; estimatedSavingsUsd: number };
  estimated: true;
}

/** Parse `7d`, `24h`, `30m`. Null when the text is not a duration. */
export function parseSince(text: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return n * unit;
}

const pct = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number);

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Build the report from receipts. `now` and `sinceMs` pick the window; `set` narrows it to one set. */
export function buildReport(receipts: readonly Receipt[], opts: { now: number; sinceMs?: number | null; sinceText?: string | null; set?: string | null }): Report {
  const cutoff = opts.sinceMs === undefined || opts.sinceMs === null ? null : opts.now - opts.sinceMs;
  const picked = receipts.filter((r) => (cutoff === null || Date.parse(r.at) >= cutoff) && (opts.set === undefined || opts.set === null || r.set === opts.set));
  const bySet = new Map<string, Receipt[]>();
  for (const r of picked) bySet.set(r.set, [...(bySet.get(r.set) ?? []), r]);
  const sets: SetReport[] = [...bySet.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([set, rs]) => {
      const ok = rs.filter((r) => r.status === "ok");
      const bands: Record<Band, number> = { high: 0, medium: 0, low: 0 };
      let decisions = 0;
      for (const r of ok) {
        for (const d of Object.values(r.decisions)) {
          if (!d.relevant) continue;
          decisions++;
          bands[d.band]++;
        }
      }
      const s1 = ok.reduce((sum, r) => sum + (r.systemOneCostUsd ?? 0), 0);
      const cf = ok.reduce((sum, r) => sum + r.counterfactualLlmCostUsd, 0);
      const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
      return {
        set,
        runs: rs.length,
        failed: rs.length - ok.length,
        decisions,
        bands,
        wouldAct: ok.filter((r) => r.overallAction === "auto" && r.route !== null).length,
        acted: rs.filter((r) => r.acted).length,
        rollouts: [...new Set(rs.map((r) => r.rollout))].sort(),
        systemOneCostUsd: round6(s1),
        unpriced: ok.filter((r) => r.systemOneCostUsd === null).length,
        counterfactualLlmCostUsd: round6(cf),
        estimatedSavingsUsd: round6(cf - s1),
        latencyP50Ms: pct(latencies, 50),
        latencyP95Ms: pct(latencies, 95),
      };
    });
  const times = picked.map((r) => r.at).sort();
  return {
    since: opts.sinceText ?? null,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    sets,
    totals: {
      runs: sets.reduce((n, s) => n + s.runs, 0),
      systemOneCostUsd: round6(sets.reduce((n, s) => n + s.systemOneCostUsd, 0)),
      counterfactualLlmCostUsd: round6(sets.reduce((n, s) => n + s.counterfactualLlmCostUsd, 0)),
      estimatedSavingsUsd: round6(sets.reduce((n, s) => n + s.estimatedSavingsUsd, 0)),
    },
    estimated: true,
  };
}

const usd = (n: number): string => `$${n.toFixed(6)}`;

/** Plain text for a person. */
export function formatReport(r: Report, path: string, skipped: number): string {
  const lines: string[] = [];
  lines.push(`bandwise report from ${path}${r.since === null ? "" : ` (last ${r.since})`}`);
  if (r.sets.length === 0) {
    lines.push("no receipts in this window. Receipts are written by `bandwise hook` and `bandwise run --live --receipts`.");
    return lines.join("\n");
  }
  lines.push(`${r.from} to ${r.to}`);
  for (const s of r.sets) {
    lines.push("");
    lines.push(`${s.set} (${s.rollouts.join(", ")})`);
    lines.push(`  runs ${s.runs}, failed ${s.failed}, decisions ${s.decisions}`);
    lines.push(`  bands high ${s.bands.high}, medium ${s.bands.medium}, low ${s.bands.low}`);
    lines.push(`  would have acted ${s.wouldAct}, acted ${s.acted}`);
    lines.push(`  System One spend ${usd(s.systemOneCostUsd)}${s.unpriced > 0 ? ` (${s.unpriced} unpriced)` : ""}`);
    lines.push(`  counterfactual LLM spend ${usd(s.counterfactualLlmCostUsd)} (estimate)`);
    lines.push(`  estimated savings ${usd(s.estimatedSavingsUsd)} (estimate)`);
    if (s.latencyP50Ms !== null) lines.push(`  latency p50 ${s.latencyP50Ms} ms, p95 ${s.latencyP95Ms} ms`);
  }
  lines.push("");
  lines.push(
    `total: ${r.totals.runs} runs, System One ${usd(r.totals.systemOneCostUsd)}, counterfactual ${usd(r.totals.counterfactualLlmCostUsd)}, estimated savings ${usd(r.totals.estimatedSavingsUsd)}`,
  );
  lines.push("Estimates: the counterfactual prices one comparator LLM call per decision from the price book. In Claude Code the real saving is fewer wasted turns and risky actions, which no receipt can price exactly.");
  if (skipped > 0) lines.push(`${skipped} line${skipped === 1 ? "" : "s"} in the file could not be read and were skipped.`);
  return lines.join("\n");
}
