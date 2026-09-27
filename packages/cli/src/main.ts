// The bandwise command line. This package ships `run --local`. Management commands over /api/v1 need
// Bandwise Cloud and are not part of it. Every command supports --json and never prompts.
// Exit codes: 0 ok, 1 error, 2 diff or drift, 3 approval pending.

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const USAGE = `Usage:
  bandwise run --local <spec.json> <state.json> [--json] [--provider typesafe|openrouter|vercel]
                     [--rollout shadow|controlled|full|paused] [--channel production|staging]

  --local   Run the spec with the fixture transport: no network call and no System One key.
            Recorded fixtures answer the requests they cover; others get synthetic answers.

Management commands (sets, publish, rollout, evals and more) work against Bandwise Cloud and
are not in this release. Nothing here needs a Bandwise account.`;

const PROVIDERS = ["typesafe", "openrouter", "vercel"] as const;
const ROLLOUTS = ["shadow", "controlled", "full", "paused"] as const;
const CHANNELS = ["production", "staging"] as const;

type Parsed =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "run-local";
      specPath: string;
      statePath: string;
      json: boolean;
      provider?: (typeof PROVIDERS)[number];
      rollout?: (typeof ROLLOUTS)[number];
      channel?: (typeof CHANNELS)[number];
    };

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (allowed as readonly string[]).includes(value);
}

/** Parse argv (without node and the script path). */
export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, ...rest] = argv;
  if (command !== "run") return { kind: "error", message: `unknown command "${command}"; this release has only "run --local"` };
  if (!rest.includes("--local")) return { kind: "error", message: "bandwise run needs --local: running a published set needs Bandwise Cloud, which this release does not call" };

  const positional: string[] = [];
  const out: Extract<Parsed, { kind: "run-local" }> = { kind: "run-local", specPath: "", statePath: "", json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = rest[i + 1];
    if (arg === "--local") continue;
    if (arg === "--json") out.json = true;
    else if (arg === "--provider") {
      if (!oneOf(PROVIDERS, value)) return { kind: "error", message: `--provider must be one of ${PROVIDERS.join(", ")}` };
      out.provider = value;
      i++;
    } else if (arg === "--rollout") {
      if (!oneOf(ROLLOUTS, value)) return { kind: "error", message: `--rollout must be one of ${ROLLOUTS.join(", ")}` };
      out.rollout = value;
      i++;
    } else if (arg === "--channel") {
      if (!oneOf(CHANNELS, value)) return { kind: "error", message: `--channel must be one of ${CHANNELS.join(", ")}` };
      out.channel = value;
      i++;
    } else if (arg.startsWith("--")) return { kind: "error", message: `unknown option ${arg}` };
    else positional.push(arg);
  }
  if (positional.length !== 2) return { kind: "error", message: "bandwise run --local needs a spec file and a state file" };
  out.specPath = positional[0] as string;
  out.statePath = positional[1] as string;
  return out;
}

/** Run the CLI for argv and return what to print and the exit code. */
export async function main(argv: readonly string[]): Promise<CommandOutput> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") return { exitCode: 0, stdout: USAGE, stderr: "" };
  if (parsed.kind === "error") return { exitCode: 1, stdout: "", stderr: `${parsed.message}\n\n${USAGE}` };
  // Local mode is loaded on demand, so the published CLI keeps core and the fixture transport optional.
  const local = await import("./local/index.js");
  const { kind: _kind, ...cmd } = parsed;
  return local.runLocalCommand(cmd);
}
