// `bandwise launch`: run the launch-profile set on a task and pick the profile
// to start the agent with. `--print` prints it as JSON and starts nothing, for hosts that start their
// own sessions (the Agent SDK, CI, cloud sessions). Without `--print` it starts the agent program the
// profiles file names, through live/spawn.ts, with `--model` and `--effort` added and nothing else
// changed.
//
// The set can only pick a profile id from the reviewed profiles file. In shadow the default is
// always used and the receipt records the pick. Any Bandwise problem (no key, a set that will not
// load, an error, a timeout) uses the default and says so on stderr. The one refusal is a profiles
// file that breaks its schema, because that means the reviewed file is wrong.

import type { SystemOneProvider, SystemOneTransport } from "@bandwise/core";
import type { CommandOutput } from "../main.js";
import { type Receipt, appendReceipt, specHash } from "../receipts/index.js";
import { loadSpec } from "../runner/index.js";
import { LAUNCH_PICKED_ENV, LAUNCH_PROFILE_ENV, launchEnv, readProviderKey } from "./key.js";
import { type LaunchProgram, type LaunchSession, type Profiles, fallbackNote, loadProfiles } from "./profiles.js";
import { failureReceipt } from "./receipt-from-result.js";
import { shapeState } from "./redact.js";
import { runLiveSpec, setSlug } from "./run-live.js";
import type { StartResult } from "./spawn.js";

/** The question in the launch-profile set whose answer is a profile id. */
export const LAUNCH_QUESTION = "profile";

export const LAUNCH_ROLLOUTS = ["shadow", "controlled", "full"] as const;
export type LaunchRollout = (typeof LAUNCH_ROLLOUTS)[number];

export const DEFAULT_LAUNCH_TIMEOUT_MS = 3_000;

export interface LaunchCommand {
  setPath: string;
  profilesPath: string;
  rollout: LaunchRollout;
  provider: SystemOneProvider;
  timeoutMs: number;
  receiptsPath: string;
  task: string;
}

export interface LaunchDeps {
  env?: Readonly<Record<string, string | undefined>>;
  transport: () => SystemOneTransport;
  now?: () => number;
  /** Tests replace the receipt writer. */
  writeReceipt?: (path: string, receipt: Receipt) => void;
}

/** What `--print` writes: the profile to use, its sessions, what the set picked, and the rollout. */
export interface LaunchPick {
  profile: string;
  sessions: LaunchSession[];
  picked: string | null;
  rollout: LaunchRollout;
}

const print = (profiles: Profiles, profile: string, picked: string | null, rollout: LaunchRollout): LaunchPick => ({
  profile,
  sessions: profiles.profiles[profile]?.sessions ?? [],
  picked,
  rollout,
});

/** The profile to start with, and the stderr note when the set was not used. */
export type LaunchChoice = { ok: true; profiles: Profiles; pick: LaunchPick; note: string | null } | { ok: false; message: string };

/**
 * Run the set on the task and choose the profile. Never throws. Only an invalid profiles file is a
 * refusal; every other problem chooses the default with a note that says why.
 */
export async function chooseProfile(cmd: LaunchCommand, deps: LaunchDeps): Promise<LaunchChoice> {
  const profiles = loadProfiles(cmd.profilesPath);
  if (!profiles.ok) return { ok: false, message: `error launch_profiles_invalid: ${profiles.message}` };
  const p = profiles.value;
  const fallback = (reason: string): LaunchChoice => ({ ok: true, profiles: p, pick: print(p, p.default, null, cmd.rollout), note: fallbackNote(p, reason) });

  const key = readProviderKey(cmd.provider, deps.env);
  if (!key.ok) return fallback(`${key.envName} is not set`);
  const loaded = loadSpec(cmd.setPath);
  if (!loaded.ok) return fallback(`the set ${cmd.setPath} could not be loaded (${loaded.code})`);
  if (cmd.task.trim() === "") return fallback("no task was given (pass --task, or put the prompt right after -p)");

  const now = deps.now ?? Date.now;
  const started = now();
  const write = deps.writeReceipt ?? appendReceipt;
  const meta = { set: setSlug(cmd.setPath), specHash: specHash(loaded.value.text), modelRequested: loaded.value.spec.model };
  const record = (receipt: Receipt, launch: NonNullable<Receipt["launch"]>): void => {
    try {
      write(cmd.receiptsPath, { ...receipt, launch });
    } catch {
      // A receipt that cannot be written never stops a launch.
    }
  };
  const failed = (status: string, reason: string): LaunchChoice => {
    record(
      failureReceipt({ ...meta, source: "launch", provider: cmd.provider, at: new Date(now()).toISOString(), acted: false, rollout: cmd.rollout, status, latencyMs: now() - started }),
      { profile: p.default, picked: null },
    );
    return fallback(reason);
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, cmd.timeoutMs);
  });
  try {
    const state = shapeState({ task: cmd.task }, loaded.value.spec.input.schema, []);
    const run = runLiveSpec(
      { spec: loaded.value, set: meta.set, state, provider: cmd.provider, rollout: cmd.rollout, source: "launch", signal: controller.signal },
      { ...(deps.env !== undefined ? { env: deps.env } : {}), transport: deps.transport(), now },
    );
    const outcome = await Promise.race([run, timedOut]);
    if (outcome === "timeout") return failed("timeout", `the set did not answer within ${cmd.timeoutMs} ms`);
    if (!outcome.ok) return failed(outcome.code, `the set failed (${outcome.code})`);
    const decision = outcome.result.decisions[LAUNCH_QUESTION];
    const value = decision?.value;
    // Only a profile id in the reviewed file counts as a pick. `unclear` or anything else is none.
    const picked = typeof value === "string" && Object.hasOwn(p.profiles, value) ? value : null;
    // Core's effective action carries the rollout: never auto in shadow, only the high band in controlled.
    const use = picked !== null && outcome.result.status === "ok" && decision?.effectiveAction === "auto" ? picked : p.default;
    record(outcome.receipt(use !== p.default), { profile: use, picked });
    if (outcome.result.status !== "ok") return fallback(`the set answered with ${outcome.result.error?.code ?? outcome.result.status}`);
    return { ok: true, profiles: p, pick: print(p, use, picked, cmd.rollout), note: null };
  } catch {
    return failed("error", "the set failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `bandwise launch --print`: the chosen profile as one line of JSON. Starts nothing. */
export async function runLaunchPrint(cmd: LaunchCommand, deps: LaunchDeps): Promise<CommandOutput> {
  const choice = await chooseProfile(cmd, deps);
  if (!choice.ok) return { exitCode: 1, stdout: "", stderr: choice.message };
  return { exitCode: 0, stdout: JSON.stringify(choice.pick), stderr: choice.note ?? "" };
}

/** Flags `bandwise launch` may add. Everything else the person passes goes through untouched. */
const OWN_FLAGS = ["--model", "--effort"] as const;

/** True when the person already passed this flag after `--`, as `--flag value` or `--flag=value`. */
function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/**
 * The argument array for the agent: `--model` and `--effort` from the first session of the profile,
 * then the person's own arguments, unchanged. A flag the person already passed wins and is not added.
 */
export function launchArgs(pick: LaunchPick, passthrough: readonly string[]): { args: string[]; skipped: string[] } {
  const session = pick.sessions[0];
  const own: string[] = [];
  const skipped: string[] = [];
  if (session !== undefined) {
    for (const flag of OWN_FLAGS) {
      if (hasFlag(passthrough, flag)) {
        skipped.push(flag);
        continue;
      }
      own.push(flag, flag === "--model" ? session.model : session.effort);
    }
  }
  return { args: [...own, ...passthrough], skipped };
}

/**
 * The task for the pick when `--task` is not given. Only two forms count, because guessing which of
 * the agent's options take a value would one day mistake a value for the prompt: the argument right
 * after `-p` or `--print`, or a single argument that is the whole passthrough (`claude "prompt"`).
 * Anything else is no task, so the default is used with a notice to pass `--task`.
 */
export function taskFromArgs(passthrough: readonly string[]): string {
  const at = passthrough.findIndex((a) => a === "-p" || a === "--print");
  if (at !== -1) {
    const next = passthrough[at + 1];
    return next !== undefined && !next.startsWith("-") ? next : "";
  }
  const only = passthrough.length === 1 ? passthrough[0] : undefined;
  return only !== undefined && !only.startsWith("-") ? only : "";
}

export interface StartDeps extends LaunchDeps {
  start: (program: LaunchProgram, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<StartResult>;
  /**
   * Writes a notice to the person before the agent starts, so "using the default" is seen before
   * the session and not when it ends. bin.ts writes to stderr. Without it, notices are returned.
   */
  warn?: (line: string) => void;
}

/**
 * `bandwise launch -- <agent args>`: choose the profile, then start the agent program named in the
 * profiles file with `--model` and `--effort` added and nothing else changed. One session per
 * launch; a profile's second session is only reported. Exits with the agent's exit code.
 */
export async function runLaunchStart(cmd: LaunchCommand, passthrough: readonly string[], deps: StartDeps): Promise<CommandOutput> {
  // The prompt the person gives the agent is the task, unless --task says otherwise.
  const task = cmd.task.trim() !== "" ? cmd.task : taskFromArgs(passthrough);
  const choice = await chooseProfile({ ...cmd, task }, deps);
  if (!choice.ok) return { exitCode: 1, stdout: "", stderr: choice.message };
  const before = choice.note === null ? [] : [choice.note];
  const { args, skipped } = launchArgs(choice.pick, passthrough);
  if (skipped.length > 0) before.push(`bandwise launch: you passed ${skipped.join(" and ")}, so the profile's value was not added.`);
  const second = choice.pick.sessions[1];
  if (second !== undefined) {
    before.push(`bandwise launch: profile "${choice.pick.profile}" names a second session (${second.model}, ${second.effort}); bandwise launch starts one session, so start it yourself if you want it.`);
  }
  // Notices go out before the agent takes the terminal.
  const held: string[] = [];
  for (const line of before) {
    if (deps.warn !== undefined) deps.warn(line);
    else held.push(line);
  }
  const env = launchEnv({ [LAUNCH_PROFILE_ENV]: choice.pick.profile, [LAUNCH_PICKED_ENV]: choice.pick.picked ?? "none" }, deps.env);
  const started = await deps.start(choice.profiles.program, args, env);
  if (!started.ok) held.push(`bandwise launch: ${started.message}`);
  return { exitCode: started.ok ? started.exitCode : 127, stdout: "", stderr: held.join("\n") };
}
