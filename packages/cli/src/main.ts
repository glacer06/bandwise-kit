// The bandwise command line. `run --local` runs a spec on fixtures. `run --live`, `hook`, `report`
// and `hooks install` run specs on your machine with your own key.
// Management commands over /api/v1 need Bandwise Cloud and are not part of this package. Every command supports --json where it prints data and
// never prompts. Exit codes: 0 ok, 1 error, 2 diff or drift, 3 approval pending.

import { formatReport, buildReport, defaultReceiptsPath, parseSince, readReceipts } from "./receipts/index.js";
import { planHooksFromDir } from "./hooks-install.js";
import type * as LiveModule from "./live/index.js";

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const USAGE = `Usage:
  bandwise run --local <spec.json> <state.json> [--json] [--provider typesafe|openrouter|vercel]
                     [--rollout shadow|controlled|full|paused] [--channel production|staging]
  bandwise run --live <spec.json> <state.json> [same options] [--receipts[=<path>]]
  bandwise report [--since 7d] [--set <slug>] [--receipts <path>] [--json]
  bandwise hook <Stop|PreToolUse|UserPromptSubmit> --set <spec.json> [--rollout shadow|controlled|full]
                     [--provider typesafe|openrouter|vercel] [--timeout-ms 3000] [--receipts <path>] [--drop <field>]
  bandwise hooks install [--sets-dir .bandwise/sets] [--command bandwise] [--rollout shadow|controlled|full]

  --local   Run the spec with the fixture transport: no network call and no System One key.
            Recorded fixtures answer the requests they cover; others get synthetic answers.
  --live    Run the spec against the real model with your own key, read only from
            TYPESAFE_API_KEY (or OPENROUTER_API_KEY, AI_GATEWAY_API_KEY with --provider).
  report    Sum the receipts in ~/.bandwise/receipts.jsonl per set. Savings are estimates.
  hook      A Claude Code hook: reads the hook JSON on stdin. In shadow it never changes anything.
            Any error or a timeout exits 0 with no output.
  hooks install
            Print the .claude/settings.json entries for the sets in the folder. Writes nothing.

Management commands (sets, publish, rollout, evals and more) work against Bandwise Cloud and
are not in this release. Nothing here needs a Bandwise account.`;

const PROVIDERS = ["typesafe", "openrouter", "vercel"] as const;
const ROLLOUTS = ["shadow", "controlled", "full", "paused"] as const;
const HOOK_ROLLOUTS = ["shadow", "controlled", "full"] as const;
const CHANNELS = ["production", "staging"] as const;
const EVENTS = ["Stop", "PreToolUse", "UserPromptSubmit"] as const;

type Provider = (typeof PROVIDERS)[number];
type RunFlags = {
  specPath: string;
  statePath: string;
  json: boolean;
  provider?: Provider;
  rollout?: (typeof ROLLOUTS)[number];
  channel?: (typeof CHANNELS)[number];
};

type Parsed =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | ({ kind: "run-local" } & RunFlags)
  | ({ kind: "run-live"; receiptsPath?: string } & RunFlags)
  | { kind: "report"; since?: string; set?: string; receiptsPath?: string; json: boolean }
  | {
      kind: "hook";
      event: (typeof EVENTS)[number];
      setPath: string;
      rollout: (typeof HOOK_ROLLOUTS)[number];
      provider: Provider;
      timeoutMs: number;
      receiptsPath?: string;
      drop: string[];
    }
  | { kind: "hooks-install"; setsDir: string; command: string; rollout: (typeof HOOK_ROLLOUTS)[number] };

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (allowed as readonly string[]).includes(value);
}

const err = (message: string): Parsed => ({ kind: "error", message });

function parseRun(rest: readonly string[]): Parsed {
  const local = rest.includes("--local");
  const live = rest.includes("--live");
  if (local && live) return err("bandwise run takes --local or --live, not both");
  if (!local && !live) return err("bandwise run needs --local or --live: running a published set needs Bandwise Cloud, which this release does not call");
  const positional: string[] = [];
  const out: RunFlags & { receiptsPath?: string } = { specPath: "", statePath: "", json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = rest[i + 1];
    if (arg === "--local" || arg === "--live") continue;
    if (arg === "--json") out.json = true;
    else if (arg === "--provider") {
      if (!oneOf(PROVIDERS, value)) return err(`--provider must be one of ${PROVIDERS.join(", ")}`);
      out.provider = value;
      i++;
    } else if (arg === "--rollout") {
      if (!oneOf(ROLLOUTS, value)) return err(`--rollout must be one of ${ROLLOUTS.join(", ")}`);
      out.rollout = value;
      i++;
    } else if (arg === "--channel") {
      if (!oneOf(CHANNELS, value)) return err(`--channel must be one of ${CHANNELS.join(", ")}`);
      out.channel = value;
      i++;
    } else if (live && (arg === "--receipts" || arg.startsWith("--receipts="))) {
      const path = arg === "--receipts" ? defaultReceiptsPath() : arg.slice("--receipts=".length);
      if (path === "") return err("--receipts= needs a path");
      out.receiptsPath = path;
    } else if (arg.startsWith("--")) return err(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const mode = live ? "--live" : "--local";
  if (positional.length !== 2) return err(`bandwise run ${mode} needs a spec file and a state file`);
  out.specPath = positional[0] as string;
  out.statePath = positional[1] as string;
  return live ? { kind: "run-live", ...out } : { kind: "run-local", ...out };
}

/** Read `--name value` pairs. Returns an error for an unknown flag or a missing value. */
function flags(rest: readonly string[], known: readonly string[], booleans: readonly string[] = [], repeatable: readonly string[] = []): Record<string, string[]> | string {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (booleans.includes(arg)) {
      out[arg] = ["true"];
      continue;
    }
    if (!known.includes(arg)) return `unknown option ${arg}`;
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
    if (out[arg] !== undefined && !repeatable.includes(arg)) return `${arg} given twice`;
    out[arg] = [...(out[arg] ?? []), value];
    i++;
  }
  return out;
}

/** Parse argv (without node and the script path). */
export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, ...rest] = argv;
  if (command === "run") return parseRun(rest);

  if (command === "report") {
    const f = flags(rest, ["--since", "--set", "--receipts"], ["--json"]);
    if (typeof f === "string") return err(f);
    const since = f["--since"]?.[0];
    if (since !== undefined && parseSince(since) === null) return err("--since takes a number and m, h or d, for example 7d");
    const out: Extract<Parsed, { kind: "report" }> = { kind: "report", json: f["--json"] !== undefined };
    if (since !== undefined) out.since = since;
    const set = f["--set"]?.[0];
    if (set !== undefined) out.set = set;
    const receipts = f["--receipts"]?.[0];
    if (receipts !== undefined) out.receiptsPath = receipts;
    return out;
  }

  if (command === "hook") {
    const [event, ...more] = rest;
    if (!oneOf(EVENTS, event)) return err(`bandwise hook needs an event: ${EVENTS.join(", ")}`);
    const f = flags(more, ["--set", "--rollout", "--provider", "--timeout-ms", "--receipts", "--drop"], [], ["--drop"]);
    if (typeof f === "string") return err(f);
    const setPath = f["--set"]?.[0];
    if (setPath === undefined) return err("bandwise hook needs --set <spec.json>");
    const rollout = f["--rollout"]?.[0] ?? "shadow";
    if (!oneOf(HOOK_ROLLOUTS, rollout)) return err(`--rollout must be one of ${HOOK_ROLLOUTS.join(", ")}`);
    const provider = f["--provider"]?.[0] ?? "typesafe";
    if (!oneOf(PROVIDERS, provider)) return err(`--provider must be one of ${PROVIDERS.join(", ")}`);
    const timeoutText = f["--timeout-ms"]?.[0] ?? "3000";
    const timeoutMs = Number(timeoutText);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) return err("--timeout-ms must be a whole number from 100 to 60000");
    const out: Extract<Parsed, { kind: "hook" }> = { kind: "hook", event, setPath, rollout, provider, timeoutMs, drop: f["--drop"] ?? [] };
    const receipts = f["--receipts"]?.[0];
    if (receipts !== undefined) out.receiptsPath = receipts;
    return out;
  }

  if (command === "hooks") {
    const [sub, ...more] = rest;
    if (sub !== "install") return err('bandwise hooks has one subcommand: "install"');
    const f = flags(more, ["--sets-dir", "--command", "--rollout"]);
    if (typeof f === "string") return err(f);
    const rollout = f["--rollout"]?.[0] ?? "shadow";
    if (!oneOf(HOOK_ROLLOUTS, rollout)) return err(`--rollout must be one of ${HOOK_ROLLOUTS.join(", ")}`);
    return { kind: "hooks-install", setsDir: f["--sets-dir"]?.[0] ?? ".bandwise/sets", command: f["--command"]?.[0] ?? "bandwise", rollout };
  }

  return err(`unknown command "${command}"; this release has run, report, hook and hooks install`);
}

export interface MainIo {
  /** Hook input. bin.ts reads process.stdin. */
  stdin?: () => Promise<string>;
  /** Environment for live mode's key lookup. Default: the process environment, read only in live/key.ts. */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Tests pass a fetch so live mode sends nothing. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Loads live mode. Tests replace it to prove a failed load stays silent in a hook. */
  loadLive?: () => Promise<typeof LiveModule>;
}

const SILENT_HOOK: CommandOutput = { exitCode: 0, stdout: "", stderr: "" };

/** Run the CLI for argv and return what to print and the exit code. */
export async function main(argv: readonly string[], io: MainIo = {}): Promise<CommandOutput> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") return { exitCode: 0, stdout: USAGE, stderr: "" };
  // A hook never fails a session, not even on a bad command line.
  if (parsed.kind === "error") return argv[0] === "hook" ? SILENT_HOOK : { exitCode: 1, stdout: "", stderr: `${parsed.message}\n\n${USAGE}` };

  if (parsed.kind === "report") {
    const path = parsed.receiptsPath ?? defaultReceiptsPath();
    const { receipts, skipped } = readReceipts(path);
    const report = buildReport(receipts, {
      now: (io.now ?? Date.now)(),
      sinceMs: parsed.since === undefined ? null : parseSince(parsed.since),
      sinceText: parsed.since ?? null,
      set: parsed.set ?? null,
    });
    return parsed.json ? { exitCode: 0, stdout: JSON.stringify({ ...report, path, skipped }, null, 2), stderr: "" } : { exitCode: 0, stdout: formatReport(report, path, skipped), stderr: "" };
  }

  if (parsed.kind === "hooks-install") {
    const plan = planHooksFromDir(parsed);
    if ("error" in plan) return { exitCode: 1, stdout: "", stderr: plan.error };
    const notes = [
      `Hook entries for ${plan.sets.length} set${plan.sets.length === 1 ? "" : "s"} in ${parsed.setsDir} (${plan.sets.join(", ") || "none"}), rollout ${parsed.rollout}.`,
      "Nothing was written. Review these entries, then merge them into .claude/settings.json yourself.",
      ...(plan.ignored.length > 0 ? [`No hook event is known for: ${plan.ignored.join(", ")}.`] : []),
    ];
    return { exitCode: 0, stdout: JSON.stringify(plan.settings, null, 2), stderr: notes.join("\n") };
  }

  if (parsed.kind === "run-local") {
    // Local mode is loaded on demand, so the published CLI keeps core and the fixture transport optional.
    const local = await import("./local/index.js");
    const { kind: _kind, ...cmd } = parsed;
    return local.runLocalCommand(cmd);
  }

  // Live mode is the only path that loads the SDK transport.
  const loadLive = io.loadLive ?? (() => import("./live/index.js"));
  if (parsed.kind === "hook") {
    // A hook never fails a session: a live module that cannot load (a missing SDK dependency,
    // a broken install) ends like any other hook error, with exit 0 and no output.
    try {
      const live = await loadLive();
      const { kind: _kind, receiptsPath, ...hook } = parsed;
      const hookIo: Parameters<typeof live.runHookCommand>[1] = { stdin: io.stdin ?? (async () => "") };
      if (io.env !== undefined) hookIo.env = io.env;
      if (io.now !== undefined) hookIo.now = io.now;
      if (io.fetch !== undefined) hookIo.fetch = io.fetch;
      return await live.runHookCommand({ ...hook, receiptsPath: receiptsPath ?? defaultReceiptsPath() }, hookIo);
    } catch {
      return SILENT_HOOK;
    }
  }
  const live = await loadLive();
  const { kind: _kind, ...cmd } = parsed;
  const liveIo: Parameters<typeof live.runLiveCommand>[1] = {};
  if (io.env !== undefined) liveIo.env = io.env;
  if (io.fetch !== undefined) liveIo.fetch = io.fetch;
  return live.runLiveCommand(cmd, liveIo);
}
