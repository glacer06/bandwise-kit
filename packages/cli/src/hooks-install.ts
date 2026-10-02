// `bandwise hooks install`: print the `the design docs` hook entries for the dogfood sets,
// for the owner to review and paste. It writes nothing.

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Which Claude Code event each agent pack set runs on, and the tools it watches. */
export const SET_EVENTS: Readonly<Record<string, { event: "Stop" | "PreToolUse" | "UserPromptSubmit"; matcher?: string }>> = Object.freeze({
  "done-check": { event: "Stop" },
  "action-risk-gate": { event: "PreToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit" },
  "model-tier": { event: "UserPromptSubmit" },
});

/** Sets in the folder that are not hooks. `launch-profile` runs before a session, from `bandwise launch`. */
export const LAUNCH_SETS: readonly string[] = Object.freeze(["launch-profile"]);

/** Seconds Claude Code waits for the command. The hook stops itself at 3 seconds; this covers start-up. */
export const HOOK_COMMAND_TIMEOUT_S = 10;

export interface InstallOptions {
  setsDir: string;
  /** How to start the CLI, for example `bandwise` or `pnpm -s --dir "$CLAUDE_PROJECT_DIR" bandwise`. */
  command: string;
  rollout: "shadow" | "controlled" | "full";
}

export interface InstallPlan {
  settings: { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string; timeout: number }> }>> };
  sets: string[];
  ignored: string[];
}

/** Build the settings entries for every known set in the folder. */
export function planHooks(o: InstallOptions, files: readonly string[]): InstallPlan {
  const hooks: InstallPlan["settings"]["hooks"] = {};
  const sets: string[] = [];
  const ignored: string[] = [];
  for (const file of [...files].sort()) {
    if (!file.endsWith(".json")) continue;
    const slug = file.replace(/\.json$/, "");
    if (LAUNCH_SETS.includes(slug)) continue;
    const target = SET_EVENTS[slug];
    if (target === undefined) {
      ignored.push(file);
      continue;
    }
    sets.push(slug);
    const setPath = `"$CLAUDE_PROJECT_DIR"/${join(o.setsDir, file)}`;
    const entry = {
      ...(target.matcher !== undefined ? { matcher: target.matcher } : {}),
      hooks: [{ type: "command" as const, command: `${o.command} hook ${target.event} --set ${setPath} --rollout ${o.rollout}`, timeout: HOOK_COMMAND_TIMEOUT_S }],
    };
    hooks[target.event] = [...(hooks[target.event] ?? []), entry];
  }
  return { settings: { hooks }, sets, ignored };
}

/** Read the folder and build the plan. */
export function planHooksFromDir(o: InstallOptions): InstallPlan | { error: string } {
  let files: string[];
  try {
    files = readdirSync(o.setsDir);
  } catch {
    return { error: `cannot read the sets folder ${o.setsDir}` };
  }
  return planHooks(o, files);
}
