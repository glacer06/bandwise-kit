// The launch profiles file: a reviewed allowlist that names
// the agent program, a default profile, and each profile as one or two sessions with a model and an
// effort. It can hold nothing else: no free-form flags, paths or commands. A file that breaks this
// shape is refused with an error that names the field, because it means the reviewed file is wrong.

import { readFileSync } from "node:fs";
import type { CommandOutput } from "../main.js";

/** Agent programs `bandwise launch` knows. Claude Code only, today. */
export const LAUNCH_PROGRAMS = ["claude"] as const;
export type LaunchProgram = (typeof LAUNCH_PROGRAMS)[number];

/** Effort levels Claude Code takes with `--effort`. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface LaunchSession {
  model: string;
  effort: Effort;
}

export interface Profiles {
  program: LaunchProgram;
  default: string;
  profiles: Record<string, { sessions: LaunchSession[] }>;
}

/** A profile id: short, no spaces, nothing that could carry text or a flag. */
export const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A model id or alias as Claude Code takes it, such as `sonnet`, `opus` or `claude-opus-5-5[1m]`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;

export type ProfilesResult = { ok: true; value: Profiles } | { ok: false; field: string; message: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Check a parsed profiles file. Every refusal names the field. */
export function parseProfiles(raw: unknown): ProfilesResult {
  const bad = (field: string, message: string): ProfilesResult => ({ ok: false, field, message: `${field}: ${message}` });
  if (!isObj(raw)) return bad("profiles file", "must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!["program", "default", "profiles"].includes(key)) return bad(key, "is not a profiles file field (program, default, profiles)");
  }
  const program = raw["program"];
  if (typeof program !== "string" || !(LAUNCH_PROGRAMS as readonly string[]).includes(program)) return bad("program", `must be one of ${LAUNCH_PROGRAMS.join(", ")}`);
  if (!isObj(raw["profiles"]) || Object.keys(raw["profiles"]).length === 0) return bad("profiles", "must name at least one profile");
  const profiles: Profiles["profiles"] = {};
  for (const [id, p] of Object.entries(raw["profiles"])) {
    const at = `profiles.${id}`;
    if (!PROFILE_ID.test(id)) return bad(at, "a profile id is letters, digits, dot, dash or underscore, up to 64 characters");
    if (!isObj(p)) return bad(at, "must be an object with sessions");
    for (const key of Object.keys(p)) if (key !== "sessions") return bad(`${at}.${key}`, "is not a profile field (sessions)");
    const sessions = p["sessions"];
    if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 2) return bad(`${at}.sessions`, "must list one or two sessions");
    const out: LaunchSession[] = [];
    for (const [i, s] of sessions.entries()) {
      const sat = `${at}.sessions[${i}]`;
      if (!isObj(s)) return bad(sat, "must be an object with model and effort");
      for (const key of Object.keys(s)) if (key !== "model" && key !== "effort") return bad(`${sat}.${key}`, "is not a session field (model, effort)");
      const model = s["model"];
      if (typeof model !== "string" || !MODEL_ID.test(model)) return bad(`${sat}.model`, "must be a model id or alias, such as sonnet or opus");
      const effort = s["effort"];
      if (typeof effort !== "string" || !(EFFORTS as readonly string[]).includes(effort)) return bad(`${sat}.effort`, `must be one of ${EFFORTS.join(", ")}`);
      out.push({ model, effort: effort as Effort });
    }
    profiles[id] = { sessions: out };
  }
  const def = raw["default"];
  if (typeof def !== "string" || !Object.hasOwn(profiles, def)) return bad("default", "must name one of the profiles");
  return { ok: true, value: { program: program as LaunchProgram, default: def, profiles } };
}

/** Read and check a profiles file. */
export function loadProfiles(path: string): ProfilesResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, field: "profiles file", message: `cannot read the profiles file ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, field: "profiles file", message: `${path} is not valid JSON` };
  }
  return parseProfiles(raw);
}

/** The one stderr line that says why the set was not used. */
export function fallbackNote(profiles: Profiles, reason: string): string {
  return `bandwise launch: ${reason}; using the default profile "${profiles.default}".`;
}

/** The default profile as `--print` JSON, with the note on stderr. */
export function launchFallback(profiles: Profiles, rollout: string, reason: string): CommandOutput {
  const pick = { profile: profiles.default, sessions: profiles.profiles[profiles.default]?.sessions ?? [], picked: null, rollout };
  return { exitCode: 0, stdout: JSON.stringify(pick), stderr: fallbackNote(profiles, reason) };
}

/** The default from a profiles file, for when live mode itself cannot load. */
export function launchFallbackFromFile(path: string, rollout: string, reason: string): CommandOutput {
  const profiles = loadProfiles(path);
  if (!profiles.ok) return { exitCode: 1, stdout: "", stderr: `error launch_profiles_invalid: ${profiles.message}` };
  return launchFallback(profiles.value, rollout, reason);
}
