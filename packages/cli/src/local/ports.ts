// RunPorts for `bandwise run --local`: the shared CLI ports with the fixture transport. No network,
// no database, no System One key.

import { SEED_MODEL_PROFILES, SEED_MODEL_ROUTES, type RunPorts, type SystemOneProvider, type TenantContext, staticKeyResolver } from "@bandwise/core";
import { FixtureTransport, loadBundledFixtures } from "@bandwise/system-one-client/fixture";
import { CLI_CONTEXT, CLI_ORG_ID, basePorts } from "../runner/index.js";

/** The org every local run belongs to. Nothing is stored anywhere. */
export const LOCAL_ORG_ID = CLI_ORG_ID;

export const LOCAL_CONTEXT: TenantContext = CLI_CONTEXT;

/** The id a synthetic answer reports as its model: an alias's observed target, or a route's build. */
export function localResolvedModel(sent: string, provider: SystemOneProvider): string {
  const aliasTarget = (id: string): string | null => SEED_MODEL_PROFILES.find((p) => p.id === id)?.aliasTarget ?? null;
  if (provider === "typesafe") return aliasTarget(sent) ?? sent;
  const route = SEED_MODEL_ROUTES.find((r) => r.provider === provider && r.providerModelId === sent);
  if (route === undefined) return sent;
  // An alias route has no builds of its own: answer with its target's route build.
  const target = aliasTarget(route.modelId);
  const build = route.resolvedIds[0] ?? SEED_MODEL_ROUTES.find((r) => r.provider === provider && r.modelId === target)?.resolvedIds[0];
  return build ?? sent;
}

export interface LocalPorts {
  ports: RunPorts;
  transport: FixtureTransport;
}

/** Ports for one local run. `now` and `newId` come from the caller, so tests can fix them. */
export function localPorts(now: () => number, newId: () => string): LocalPorts {
  const transport = new FixtureTransport(loadBundledFixtures(), { synthesize: true, resolveModel: localResolvedModel });
  // Local mode sends nothing anywhere, so the key is a placeholder that never leaves the process.
  const keys = staticKeyResolver({ typesafe: "local-fixture", openrouter: "local-fixture", vercel: "local-fixture" });
  return { ports: basePorts(transport, keys, now, newId), transport };
}
