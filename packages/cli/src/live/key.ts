// The one CLI module that reads a System One key. The key comes from the environment
// variable that matches the provider, of the person running the command. Never from a flag, a spec,
// a profile or a file. It is never printed or logged: errors name the variable, never a value.

import type { SystemOneProvider } from "@bandwise/core";

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
