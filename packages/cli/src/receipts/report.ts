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

/** The done-check question whose answer says whether a task was finished. */
const DONE_QUESTION = "turn_outcome";

/** One row of `bandwise report --compare profile`: the tasks run on one profile with one pick. */
export interface CompareGroup {
  /** The profile the session ran on, or `none` outside `bandwise launch`. */
  profile: string;
  /** The profile the launch-profile set would have picked, or `none`. */
  picked: string;
  /** True when the pick was a different profile from the one used. */
  differs: boolean;
  tasks: number;
  /** Tasks whose request time was in the transcript read, so their time counts. */
  timed: number;
  taskP50Ms: number | null;
  turnsP50: number | null;
  toolCallsP50: number | null;
  /** Tasks done-check answered, and how many it called finished. */
  checked: number;
  finished: number;
  outcomes: Record<string, number>;
}

export interface CompareReport {
  by: "profile";
  since: string | null;
  groups: CompareGroup[];
  /** Stop receipts with no session block, such as those from older CLIs. Not counted. */
  withoutSession: number;
  estimated: true;
}

/**
 * Group Stop receipts by the launch profile used and the one picked. Medians, not means:
 * one long task should not swing a small sample. Every row carries its sample size.
 */
export function buildCompare(receipts: readonly Receipt[], opts: { now: number; sinceMs?: number | null; sinceText?: string | null; set?: string | null }): CompareReport {
  const cutoff = opts.sinceMs === undefined || opts.sinceMs === null ? null : opts.now - opts.sinceMs;
  const picked = receipts.filter(
    (r) => r.source === "Stop" && (cutoff === null || Date.parse(r.at) >= cutoff) && (opts.set === undefined || opts.set === null || r.set === opts.set),
  );
  const groups = new Map<string, Receipt[]>();
  let withoutSession = 0;
  for (const r of picked) {
    if (r.session === undefined) {
      withoutSession++;
      continue;
    }
    const k = JSON.stringify([r.session.profile ?? "none", r.session.profilePicked ?? "none"]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const median = (xs: number[]): number | null => pct([...xs].sort((a, b) => a - b), 50);
  const rows: CompareGroup[] = [...groups.entries()]
    .map(([k, rs]) => {
      const [profile, pick] = JSON.parse(k) as [string, string];
      const sessions = rs.map((r) => r.session).filter((s): s is NonNullable<Receipt["session"]> => s !== undefined);
      const times = sessions.map((s) => s.taskMs).filter((t): t is number => t !== null);
      const outcomes: Record<string, number> = {};
      for (const r of rs) {
        const d = r.status === "ok" ? r.decisions[DONE_QUESTION] : undefined;
        if (d === undefined || d.value === null) continue;
        const v = String(d.value);
        outcomes[v] = (outcomes[v] ?? 0) + 1;
      }
      const checked = Object.values(outcomes).reduce((n, c) => n + c, 0);
      return {
        profile,
        picked: pick,
        differs: pick !== "none" && pick !== profile,
        tasks: rs.length,
        timed: times.length,
        taskP50Ms: median(times),
        turnsP50: median(sessions.map((s) => s.turns)),
        toolCallsP50: median(sessions.map((s) => s.toolCalls)),
        checked,
        finished: outcomes["finished"] ?? 0,
        outcomes,
      };
    })
    .sort((a, b) => a.profile.localeCompare(b.profile) || a.picked.localeCompare(b.picked));
  return { by: "profile", since: opts.sinceText ?? null, groups: rows, withoutSession, estimated: true };
}

const secs = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

/** Plain text for a person. */
export function formatCompare(r: CompareReport, path: string, skipped: number): string {
  const lines: string[] = [];
  lines.push(`bandwise report --compare profile from ${path}${r.since === null ? "" : ` (last ${r.since})`}`);
  if (r.groups.length === 0) {
    lines.push("no Stop receipts with session data in this window. Only the Stop hook of this CLI version and later writes them.");
  }
  for (const g of r.groups) {
    lines.push("");
    lines.push(`profile ${g.profile}, pick ${g.picked}${g.differs ? " (pick differs)" : ""}: ${g.tasks} task${g.tasks === 1 ? "" : "s"}`);
    lines.push(`  time to stop p50 ${secs(g.taskP50Ms)} (${g.timed} timed)`);
    lines.push(`  turns p50 ${g.turnsP50 ?? "n/a"}, tool calls p50 ${g.toolCallsP50 ?? "n/a"}`);
    const rest = Object.entries(g.outcomes)
      .filter(([k]) => k !== "finished")
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    lines.push(`  done-check finished ${g.finished} of ${g.checked}${rest === "" ? "" : ` (${rest})`}`);
  }
  if (r.withoutSession > 0) lines.push("", `${r.withoutSession} Stop receipt${r.withoutSession === 1 ? "" : "s"} without session data (from an older CLI) not counted.`);
  lines.push("");
  lines.push("Estimates from one machine. Medians over small samples move a lot; read the task counts before the times. In shadow every task runs on the default profile, so a differing pick shows what the set would have chosen, not what it would have changed.");
  if (skipped > 0) lines.push(`${skipped} line${skipped === 1 ? "" : "s"} in the file could not be read and were skipped.`);
  return lines.join("\n");
}
