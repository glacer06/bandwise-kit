// Local mode of @bandwise/cli. The only CLI folder that may import core and the fixture subpath of
// system-one-client; bin.ts loads it with a dynamic import, so the published package keeps both
// as optional peer dependencies.

import type { RolloutStage, SystemOneProvider } from "@bandwise/core";
import type { CommandOutput } from "../main.js";
import { formatRun } from "./format.js";
import { runLocal } from "./run-local.js";

export { formatRun } from "./format.js";
export { LOCAL_CONTEXT, localPorts, localResolvedModel } from "./ports.js";
export { type LocalRunOptions, type LocalRunOutcome, runLocal } from "./run-local.js";

export interface LocalCommand {
  specPath: string;
  statePath: string;
  json: boolean;
  provider?: SystemOneProvider;
  rollout?: RolloutStage;
  channel?: "production" | "staging";
}

/** Run the local command and render its output. Exit 0 on an ok run, 1 otherwise. */
export async function runLocalCommand(cmd: LocalCommand): Promise<CommandOutput> {
  const options: Parameters<typeof runLocal>[0] = { specPath: cmd.specPath, statePath: cmd.statePath };
  if (cmd.provider !== undefined) options.provider = cmd.provider;
  if (cmd.rollout !== undefined) options.rollout = cmd.rollout;
  if (cmd.channel !== undefined) options.channel = cmd.channel;
  const outcome = await runLocal(options);
  if (!outcome.ok) {
    const body = { error: { code: outcome.code, message: outcome.message, details: outcome.details } };
    const text = cmd.json
      ? JSON.stringify(body, null, 2)
      : [`error ${outcome.code}: ${outcome.message}`, ...outcome.details.map((d) => `  ${d.rule} at ${d.path || "/"}: ${d.message}`)].join("\n");
    return { exitCode: 1, stdout: cmd.json ? text : "", stderr: cmd.json ? "" : text };
  }
  const exitCode = outcome.result.status === "ok" ? 0 : 1;
  if (cmd.json) {
    const notes = outcome.lint.map((l) => `${l.severity} ${l.rule} at ${l.path || "/"}: ${l.message}`);
    if (outcome.answersFrom.includes("synthetic")) notes.push("some answers are synthetic: no recorded fixture matched the request");
    return { exitCode, stdout: JSON.stringify(outcome.result, null, 2), stderr: notes.join("\n") };
  }
  return { exitCode, stdout: formatRun(outcome.result, outcome.lint, outcome.answersFrom), stderr: "" };
}
