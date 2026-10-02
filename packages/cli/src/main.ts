// The bandwise command line. `run --local` runs a spec on fixtures. `run --live`, `hook`, `report`
// and `hooks install` run specs on your machine with your own key. `spec`, `publish`,
// `rollback`, `rollout` and `report --remote` call hosted Bandwise with BANDWISE_TOKEN, and `hook`
// calls the hosted run endpoint when BANDWISE_TOKEN is set.
// Other management commands over /api/v1 land in a later release. Every command supports --json where it prints data and
// never prompts. Exit codes: 0 ok, 1 error, 2 diff or drift, 3 approval pending.

import { buildCompare, buildReport, defaultReceiptsPath, formatCompare, formatReport, parseSince, readReceipts } from "./receipts/index.js";
import { planHooksFromDir } from "./hooks-install.js";
import type * as LiveModule from "./live/index.js";
import type { LaunchPick } from "./live/launch.js";
import { createClient } from "./remote/client.js";
import { type RemoteCommand, STAGES, runRemoteCommand } from "./remote/commands.js";
import { TOKEN_ENV, readRemote, scrubToken } from "./remote/credentials.js";

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const USAGE = `Usage:
  bandwise run --local <spec.json> <state.json> [--json] [--provider typesafe|openrouter|vercel]
                     [--rollout shadow|controlled|full|paused] [--channel production|staging]
  bandwise run --live <spec.json> <state.json> [same options] [--receipts[=<path>]]
  bandwise report [--since 7d] [--set <slug>] [--receipts <path>] [--compare profile] [--json]
  bandwise report --remote [--since 7d] [--set <slug>] [--json]
  bandwise hook <Stop|PreToolUse|UserPromptSubmit> --set <spec.json> [--rollout shadow|controlled|full]
                     [--provider typesafe|openrouter|vercel] [--timeout-ms 3000] [--receipts <path>] [--drop <field>]
                     [--remote-set <slug>]
  bandwise hooks install [--sets-dir .bandwise/sets] [--command bandwise] [--rollout shadow|controlled|full]
  bandwise launch [--task <text>] [--set .bandwise/sets/launch-profile.json]
                     [--profiles .bandwise/profiles.json] [--rollout shadow|controlled|full]
                     [--provider typesafe|openrouter|vercel] [--timeout-ms 3000] [--receipts <path>]
                     [--print | -- <agent args>]
  bandwise spec pull <set> [--out <file>] [--json]
  bandwise spec push <file> [--set <slug>] [--goal <goalId> [--name <text>]] [--if-match <etag>] [--json]
  bandwise spec diff <file> [--set <slug>] [--version <n>] [--json]
  bandwise publish <set> [--channel production|staging] [--changelog <text>] [--if-match <etag>] [--json]
  bandwise rollback <set> [--channel production|staging] [--to <n>] [--json]
  bandwise rollout <set> <inactive|shadow|controlled|full|paused> [--channel production|staging]
                     [--reason <text>] [--json]

  --local   Run the spec with the fixture transport: no network call and no System One key.
            Recorded fixtures answer the requests they cover; others get synthetic answers.
  --live    Run the spec against the real model with your own key, read only from
            TYPESAFE_API_KEY (or OPENROUTER_API_KEY, AI_GATEWAY_API_KEY with --provider).
  report    Sum the receipts in ~/.bandwise/receipts.jsonl per set. Savings are estimates.
            --compare profile groups Stop receipts by launch profile: time to stop, turns,
            tool calls and done-check outcomes, with the sample size on every row.
  hook      A Claude Code hook: reads the hook JSON on stdin. In shadow it never changes anything.
            Any error or a timeout exits 0 with no output.
  hooks install
            Print the .claude/settings.json entries for the sets in the folder. Writes nothing.
  launch    Pick a launch profile for a task and start the agent the profiles file names
            (claude) with --model and --effort added. Arguments after -- go to the agent
            unchanged. The task is --task, or else the argument right after -p, or else a lone
            argument after --. Other forms have no task and start the default, so pass --task.
            It exits with the agent's exit code.
            --print prints the pick as JSON instead and starts nothing:
            {"profile", "sessions": [{"model", "effort"}], "picked", "rollout"}. With --print the
            task is --task or stdin.
            In shadow the default is always used. Without a key, or on an error or a timeout,
            the default is used and stderr says why.

Hosted Bandwise. These read BANDWISE_TOKEN and BANDWISE_BASE_URL (default https://app.bandwise.dev)
and never a provider key. The token is sent only as a bearer header and is never printed.
  spec pull Print the set's draft, or write it to --out. stderr has the draft ETag.
  spec push Replace the set's draft with the file and show the lint results. The set slug is the
            file name without .json, or --set. A set that does not exist is created when --goal
            is given. The draft ETag comes from the server unless --if-match is given.
  spec diff Compare the file with the draft, or with a published --version. Exit 2 on a difference.
  publish   Publish the draft to a channel (default production).
  rollback  Point a channel back at the version it served before, or at an earlier one with --to.
  rollout   Set a channel's rollout stage.
            publish, rollback and rollout exit 3 when a person must approve, and print the
            approval id and the console link.
  report --remote
            Runs, spend and estimated savings per set from the server (usage.get).
  hook      With BANDWISE_TOKEN set, a hook calls POST /api/v1/sets/<slug>/run, where <slug> is
            the --set file name or --remote-set. The local spec still decides which fields are
            sent. The server's rollout stage for the set decides whether the hook may act, so
            --rollout and --provider do nothing in this mode. Receipts are still written.

Other management commands (sets, evals, approvals and more) land in a later release.`;

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
  | { kind: "report"; since?: string; set?: string; receiptsPath?: string; compare?: "profile"; json: boolean }
  | RemoteCommand
  | {
      kind: "hook";
      event: (typeof EVENTS)[number];
      setPath: string;
      rollout: (typeof HOOK_ROLLOUTS)[number];
      provider: Provider;
      timeoutMs: number;
      receiptsPath?: string;
      drop: string[];
      remoteSet?: string;
    }
  | { kind: "hooks-install"; setsDir: string; command: string; rollout: (typeof HOOK_ROLLOUTS)[number] }
  | {
      kind: "launch";
      setPath: string;
      profilesPath: string;
      rollout: (typeof HOOK_ROLLOUTS)[number];
      provider: Provider;
      timeoutMs: number;
      receiptsPath?: string;
      task?: string;
      print: boolean;
      /** Everything after `--`, for the agent. */
      passthrough: string[];
    };

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
  // Arguments after `--` belong to the agent `bandwise launch` starts, so --help there is not ours.
  const ours = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  if (argv.length === 0 || ours.includes("--help") || ours.includes("-h")) return { kind: "help" };
  const [command, ...rest] = argv;
  if (command === "run") return parseRun(rest);

  if (command === "report") {
    const f = flags(rest, ["--since", "--set", "--receipts", "--compare"], ["--json", "--remote"]);
    if (typeof f === "string") return err(f);
    const since = f["--since"]?.[0];
    const sinceMs = since === undefined ? null : parseSince(since);
    if (since !== undefined && sinceMs === null) return err("--since takes a number and m, h or d, for example 7d");
    if (f["--remote"] !== undefined) {
      if (f["--receipts"] !== undefined || f["--compare"] !== undefined) return err("report --remote reads the server, so it takes no --receipts or --compare");
      const remote: Extract<Parsed, { kind: "report-remote" }> = { kind: "report-remote", json: f["--json"] !== undefined };
      if (since !== undefined && sinceMs !== null) remote.since = { text: since, ms: sinceMs };
      const set = f["--set"]?.[0];
      if (set !== undefined) remote.set = set;
      return remote;
    }
    const out: Extract<Parsed, { kind: "report" }> = { kind: "report", json: f["--json"] !== undefined };
    if (since !== undefined) out.since = since;
    const set = f["--set"]?.[0];
    if (set !== undefined) out.set = set;
    const receipts = f["--receipts"]?.[0];
    if (receipts !== undefined) out.receiptsPath = receipts;
    const compare = f["--compare"]?.[0];
    if (compare !== undefined && compare !== "profile") return err("--compare takes profile");
    if (compare !== undefined) out.compare = compare;
    return out;
  }

  if (command === "hook") {
    const [event, ...more] = rest;
    if (!oneOf(EVENTS, event)) return err(`bandwise hook needs an event: ${EVENTS.join(", ")}`);
    const f = flags(more, ["--set", "--rollout", "--provider", "--timeout-ms", "--receipts", "--drop", "--remote-set"], [], ["--drop"]);
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
    const remoteSet = f["--remote-set"]?.[0];
    if (remoteSet !== undefined) out.remoteSet = remoteSet;
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

  if (command === "launch") {
    const sep = rest.indexOf("--");
    const own = sep < 0 ? rest : rest.slice(0, sep);
    const passthrough = sep < 0 ? [] : rest.slice(sep + 1);
    const f = flags(own, ["--set", "--profiles", "--rollout", "--provider", "--timeout-ms", "--receipts", "--task"], ["--print"]);
    if (typeof f === "string") return err(f);
    const print = f["--print"] !== undefined;
    if (print && passthrough.length > 0) return err("bandwise launch --print starts nothing, so it takes no agent arguments after --");
    const rollout = f["--rollout"]?.[0] ?? "shadow";
    if (!oneOf(HOOK_ROLLOUTS, rollout)) return err(`--rollout must be one of ${HOOK_ROLLOUTS.join(", ")}`);
    const provider = f["--provider"]?.[0] ?? "typesafe";
    if (!oneOf(PROVIDERS, provider)) return err(`--provider must be one of ${PROVIDERS.join(", ")}`);
    const timeoutMs = Number(f["--timeout-ms"]?.[0] ?? "3000");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) return err("--timeout-ms must be a whole number from 100 to 60000");
    const out: Extract<Parsed, { kind: "launch" }> = {
      kind: "launch",
      setPath: f["--set"]?.[0] ?? ".bandwise/sets/launch-profile.json",
      profilesPath: f["--profiles"]?.[0] ?? ".bandwise/profiles.json",
      rollout,
      provider,
      timeoutMs,
      print,
      passthrough,
    };
    const receipts = f["--receipts"]?.[0];
    if (receipts !== undefined) out.receiptsPath = receipts;
    const task = f["--task"]?.[0];
    if (task !== undefined) out.task = task;
    return out;
  }

  if (command === "spec" || command === "publish" || command === "rollback" || command === "rollout") return parseRemote(command, rest);

  return err(`unknown command "${command}"; this release has run, report, hook, hooks install, launch, spec, publish, rollback and rollout`);
}

/** A positive whole number, or null. */
function positiveInt(text: string | undefined): number | null {
  if (text === undefined || !/^[1-9]\d{0,8}$/.test(text)) return null;
  return Number(text);
}

/** Split positional arguments from `--name value` pairs and boolean flags. */
function splitArgs(rest: readonly string[], booleans: readonly string[]): { positional: string[]; options: string[] } {
  const positional: string[] = [];
  const options: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) positional.push(arg);
    else if (booleans.includes(arg) || i + 1 >= rest.length) options.push(arg);
    else options.push(arg, rest[++i] as string);
  }
  return { positional, options };
}

const REMOTE_FLAGS: Record<string, string[]> = {
  pull: ["--out"],
  push: ["--set", "--goal", "--name", "--if-match"],
  diff: ["--set", "--version"],
  publish: ["--channel", "--changelog", "--if-match"],
  rollback: ["--channel", "--to"],
  rollout: ["--channel", "--reason"],
};

/** `spec pull|push|diff`, `publish`, `rollback` and `rollout`. */
function parseRemote(command: "spec" | "publish" | "rollback" | "rollout", rest: readonly string[]): Parsed {
  const sub = command === "spec" ? rest[0] : command;
  if (sub !== "pull" && sub !== "push" && sub !== "diff" && command === "spec") return err('bandwise spec has three subcommands: "pull", "push" and "diff"');
  const name = sub as string;
  const { positional, options } = splitArgs(command === "spec" ? rest.slice(1) : rest, ["--json"]);
  const f = flags(options, REMOTE_FLAGS[name] ?? [], ["--json"]);
  if (typeof f === "string") return err(f);
  const json = f["--json"] !== undefined;
  const one = (flag: string): string | undefined => f[flag]?.[0];
  const label = command === "spec" ? `bandwise spec ${name}` : `bandwise ${command}`;
  const wanted = command === "rollout" ? 2 : 1;
  const what = name === "push" || name === "diff" ? "a spec file" : command === "rollout" ? "a set and a stage" : "a set";
  if (positional.length !== wanted) return err(`${label} needs ${what}`);
  const first = positional[0] as string;
  const channel = one("--channel") ?? "production";
  if (!oneOf(CHANNELS, channel)) return err(`--channel must be one of ${CHANNELS.join(", ")}`);
  /** `{ key: value }` when the flag was given, else nothing, for optional fields. */
  const opt = (key: string, flag: string): Record<string, string> => {
    const v = one(flag);
    return v === undefined ? {} : { [key]: v };
  };

  switch (name) {
    case "pull":
      return { kind: "spec-pull", set: first, json, ...opt("out", "--out") };
    case "push":
      if (one("--name") !== undefined && one("--goal") === undefined) return err("--name is used only when --goal creates the set");
      return { kind: "spec-push", file: first, json, ...opt("set", "--set"), ...opt("goal", "--goal"), ...opt("name", "--name"), ...opt("ifMatch", "--if-match") };
    case "diff": {
      const version = positiveInt(one("--version"));
      if (one("--version") !== undefined && version === null) return err("--version takes a version number, for example 3");
      return { kind: "spec-diff", file: first, json, ...opt("set", "--set"), ...(version !== null ? { version } : {}) };
    }
    case "publish":
      return { kind: "publish", set: first, channel, json, ...opt("changelog", "--changelog"), ...opt("ifMatch", "--if-match") };
    case "rollback": {
      const to = positiveInt(one("--to"));
      if (one("--to") !== undefined && to === null) return err("--to takes a version number, for example 3");
      return { kind: "rollback", set: first, channel, json, ...(to !== null ? { to } : {}) };
    }
    default: {
      const stage = positional[1];
      if (!oneOf(STAGES, stage)) return err(`the stage must be one of ${STAGES.join(", ")}`);
      return { kind: "rollout", set: first, stage, channel, json, ...opt("reason", "--reason") };
    }
  }
}

const REMOTE_KINDS: ReadonlySet<string> = new Set<RemoteCommand["kind"]>(["spec-pull", "spec-push", "spec-diff", "publish", "rollback", "rollout", "report-remote"]);
const isRemote = (p: Parsed): p is RemoteCommand => REMOTE_KINDS.has(p.kind);

/** Run a remote command. Everything it prints passes through scrubToken, the last guard for the token. */
async function remoteMain(cmd: RemoteCommand, io: MainIo): Promise<CommandOutput> {
  const lookup = readRemote(io.env);
  if (lookup.kind !== "ok") {
    const message = lookup.kind === "none" ? `${TOKEN_ENV} is not set. The ${cmd.kind === "report-remote" ? "report --remote" : cmd.kind.replace("-", " ")} command calls hosted Bandwise with a Bandwise token.` : lookup.message;
    return cmd.json ? { exitCode: 1, stdout: JSON.stringify({ error: { code: "unauthenticated", message } }, null, 2), stderr: "" } : { exitCode: 1, stdout: "", stderr: `error: ${message}` };
  }
  const { token } = lookup.remote;
  const client = createClient(lookup.remote, io.fetch !== undefined ? { fetch: io.fetch } : {});
  const out = await runRemoteCommand(cmd, { client, ...(io.now !== undefined ? { now: io.now } : {}) });
  return { exitCode: out.exitCode, stdout: scrubToken(out.stdout, token), stderr: scrubToken(out.stderr, token) };
}

/** Start the agent on the default profile when live mode itself failed to load. */
async function startDefaultWithoutLive(
  cmd: { profilesPath: string; passthrough: readonly string[] },
  fallback: CommandOutput,
  io: MainIo,
): Promise<CommandOutput> {
  const { loadProfiles } = await import("./live/profiles.js");
  const profiles = loadProfiles(cmd.profilesPath);
  if (!profiles.ok) return fallback;
  const pick = JSON.parse(fallback.stdout) as LaunchPick;
  const { launchArgs } = await import("./live/launch.js");
  const { args } = launchArgs(pick, cmd.passthrough);
  const { launchEnv, LAUNCH_PICKED_ENV, LAUNCH_PROFILE_ENV } = await import("./live/key.js");
  const env = launchEnv({ [LAUNCH_PROFILE_ENV]: pick.profile, [LAUNCH_PICKED_ENV]: "none" }, io.env);
  const start = io.start ?? (await import("./live/spawn.js")).startProgram;
  // Say it before the agent takes the terminal.
  const held: string[] = [];
  if (io.warn !== undefined) io.warn(fallback.stderr);
  else held.push(fallback.stderr);
  const started = await start(profiles.value.program, args, env);
  if (!started.ok) held.push(`bandwise launch: ${started.message}`);
  return { exitCode: started.ok ? started.exitCode : 127, stdout: "", stderr: held.join("\n") };
}

export interface MainIo {
  /** Hook input. bin.ts reads process.stdin. */
  stdin?: () => Promise<string>;
  /** Environment for the key and token lookups. Default: the process environment, read only in live/key.ts and remote/credentials.ts. */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Tests pass a fetch so live mode sends nothing. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Starts the agent for `bandwise launch`. Tests pass a fake; the default is live/spawn.ts. */
  start?: (program: "claude", args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<{ ok: true; exitCode: number } | { ok: false; message: string }>;
  /** Notices `bandwise launch` shows before the agent starts. bin.ts writes them to stderr at once. */
  warn?: (line: string) => void;
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
  if (isRemote(parsed)) return remoteMain(parsed, io);

  if (parsed.kind === "report") {
    const path = parsed.receiptsPath ?? defaultReceiptsPath();
    const { receipts, skipped } = readReceipts(path);
    const window = {
      now: (io.now ?? Date.now)(),
      sinceMs: parsed.since === undefined ? null : parseSince(parsed.since),
      sinceText: parsed.since ?? null,
      set: parsed.set ?? null,
    };
    if (parsed.compare === "profile") {
      const compare = buildCompare(receipts, window);
      return parsed.json ? { exitCode: 0, stdout: JSON.stringify({ ...compare, path, skipped }, null, 2), stderr: "" } : { exitCode: 0, stdout: formatCompare(compare, path, skipped), stderr: "" };
    }
    const report = buildReport(receipts, window);
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
    // With BANDWISE_TOKEN set the hook calls hosted Bandwise and loads neither core nor the SDK.
    // A token with a bad base URL ends silent, like any other hook error.
    const remote = readRemote(io.env);
    if (remote.kind === "error") return SILENT_HOOK;
    if (remote.kind === "ok") {
      try {
        const { runRemoteHook } = await import("./live/hook-remote.js");
        const { event, setPath, timeoutMs, drop, receiptsPath, remoteSet } = parsed;
        const hookIo: Parameters<typeof runRemoteHook>[1] = { stdin: io.stdin ?? (async () => ""), remote: remote.remote };
        if (io.env !== undefined) hookIo.env = io.env;
        if (io.now !== undefined) hookIo.now = io.now;
        if (io.fetch !== undefined) hookIo.fetch = io.fetch;
        const out = await runRemoteHook({ event, setPath, timeoutMs, drop, receiptsPath: receiptsPath ?? defaultReceiptsPath(), ...(remoteSet !== undefined ? { remoteSet } : {}) }, hookIo);
        return { exitCode: 0, stdout: scrubToken(out.stdout, remote.remote.token), stderr: "" };
      } catch {
        return SILENT_HOOK;
      }
    }
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
  if (parsed.kind === "launch") {
    const { kind: _kind, receiptsPath, task, ...rest } = parsed;
    // --print reads the task from stdin when --task is absent. A real launch leaves stdin to the agent.
    const fromStdin = async (): Promise<string> => (rest.print && io.stdin !== undefined ? await io.stdin() : "");
    const cmd = { ...rest, receiptsPath: receiptsPath ?? defaultReceiptsPath(), task: task ?? (rest.print ? await fromStdin() : "") };
    try {
      const live = await loadLive();
      const launchIo: Parameters<typeof live.runLaunchCommand>[1] = {};
      if (io.env !== undefined) launchIo.env = io.env;
      if (io.now !== undefined) launchIo.now = io.now;
      if (io.fetch !== undefined) launchIo.fetch = io.fetch;
      if (io.start !== undefined) launchIo.start = io.start;
      if (io.warn !== undefined) launchIo.warn = io.warn;
      return await live.runLaunchCommand(cmd, launchIo);
    } catch {
      // A live module that cannot load still uses the default, so a launch is never blocked.
      const { launchFallbackFromFile } = await import("./live/profiles.js");
      const fallback = launchFallbackFromFile(cmd.profilesPath, cmd.rollout, "live mode could not load");
      if (cmd.print || fallback.exitCode !== 0) return fallback;
      return startDefaultWithoutLive(cmd, fallback, io);
    }
  }

  const live = await loadLive();
  const { kind: _kind, ...cmd } = parsed;
  const liveIo: Parameters<typeof live.runLiveCommand>[1] = {};
  if (io.env !== undefined) liveIo.env = io.env;
  if (io.fetch !== undefined) liveIo.fetch = io.fetch;
  return live.runLiveCommand(cmd, liveIo);
}
