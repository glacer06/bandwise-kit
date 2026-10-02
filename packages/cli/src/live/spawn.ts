// The one CLI module that starts another program. A boundary
// rule, a CLI test and the kit's ESLint config keep every other module off node:child_process.
//
// It starts exactly the program it is given (only a name from the profiles file's fixed list), with
// an argument array and never a shell, so nothing in an argument is ever parsed as shell syntax. The
// program inherits the terminal. Ctrl-C reaches it from the terminal directly; this process ignores
// it and waits, and passes SIGTERM and SIGHUP on. The result is the program's exit code.

import { type ChildProcess, spawn } from "node:child_process";
import type { LaunchProgram } from "./profiles.js";

export type StartResult = { ok: true; exitCode: number } | { ok: false; message: string };

/** The part of node's spawn this module uses. Tests pass a fake. */
export type SpawnFn = (command: string, args: readonly string[], options: { stdio: "inherit"; shell: false; env: Record<string, string | undefined> }) => ChildProcess;

/** Exit code for a program ended by a signal, as shells report it: 128 plus the signal number. */
const SIGNAL_CODES: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** Start `program` with `args` and wait for it. Never throws. */
export function startProgram(
  program: LaunchProgram,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: { spawn?: SpawnFn; signals?: Pick<NodeJS.Process, "on" | "off"> } = {},
): Promise<StartResult> {
  const run = deps.spawn ?? (spawn as unknown as SpawnFn);
  const signals = deps.signals ?? process;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = run(program, [...args], { stdio: "inherit", shell: false, env: { ...env } });
    } catch (e) {
      resolve({ ok: false, message: `could not start ${program}: ${(e as Error).message}` });
      return;
    }
    const ignore = (): void => undefined;
    const pass = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onTerm = pass("SIGTERM");
    const onHup = pass("SIGHUP");
    signals.on("SIGINT", ignore);
    signals.on("SIGTERM", onTerm);
    signals.on("SIGHUP", onHup);
    const done = (result: StartResult): void => {
      signals.off("SIGINT", ignore);
      signals.off("SIGTERM", onTerm);
      signals.off("SIGHUP", onHup);
      resolve(result);
    };
    child.once("error", (e: NodeJS.ErrnoException) => {
      done({ ok: false, message: e.code === "ENOENT" ? `${program} was not found on your PATH` : `could not start ${program}: ${e.message}` });
    });
    child.once("exit", (code, signal) => {
      done({ ok: true, exitCode: code ?? (signal !== null ? 128 + (SIGNAL_CODES[signal] ?? 1) : 1) });
    });
  });
}
