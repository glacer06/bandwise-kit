// The one CLI module that reads a provider key. The System One key comes from the
// variable that matches the provider, of the person running the command. Never from a flag, a spec,
// a profile or a file. It is never printed or logged: errors name the variable, never a value.
// The launch profile variables below are not secrets; they live here so one file owns these reads.
// The Bandwise token and base URL are read in remote/credentials.ts.

import type { SystemOneProvider } from "@bandwise/core";
import { PROFILE_ID } from "./profiles.js";

/** The environment variable that holds each provider's key. */
export const PROVIDER_KEY_ENV: Readonly<Record<SystemOneProvider, string>> = Object.freeze({
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
});

export type KeyLookup = { ok: true; apiKey: string } | { ok: false; envName: string; message: string };

/** Read the key for a provider. `env` defaults to process.env; tests pass their own. */
export function readProviderKey(provider: SystemOneProvider, env: Readonly<Record<string, string | undefined>> = process.env): KeyLookup {
  const envName = PROVIDER_KEY_ENV[provider];
  const value = env[envName];
  if (value === undefined || value.trim() === "") {
    return { ok: false, envName, message: `${envName} is not set. Live mode on ${provider} reads the key from ${envName} in your environment, and nowhere else.` };
  }
  return { ok: true, apiKey: value.trim() };
}

/** For the agent `bandwise launch` starts, so its hooks can record the profile. A host that runs `--print` can set them itself. */
export const LAUNCH_PROFILE_ENV = "BANDWISE_LAUNCH_PROFILE";
export const LAUNCH_PICKED_ENV = "BANDWISE_LAUNCH_PICKED";


/** The launch profile a session started with and the one picked. Anything that is not a profile id reads as null. */
export function readLaunchProfile(env: Readonly<Record<string, string | undefined>> = process.env): { profile: string | null; picked: string | null } {
  const id = (name: string): string | null => {
    const v = env[name]?.trim();
    return v !== undefined && PROFILE_ID.test(v) ? v : null;
  };
  return { profile: id(LAUNCH_PROFILE_ENV), picked: id(LAUNCH_PICKED_ENV) };
}

/**
 * The environment for the agent `bandwise launch` starts: the person's own, as the agent would get
 * it anyway, plus the launch profile variables. Nothing is taken out and no key is added.
 */
export function launchEnv(extra: Readonly<Record<string, string>>, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string | undefined> {
  return { ...env, ...extra };
}
