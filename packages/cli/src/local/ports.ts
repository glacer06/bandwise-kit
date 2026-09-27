// RunPorts for `bandwise run --local`: core's in-memory ports, the seed model registry and price
// book, and the fixture transport. No network, no database, no System One key.

import {
  type RunPorts,
  SEED_COMPARATOR_PRICES,
  SEED_MODEL_PROFILES,
  SEED_MODEL_ROUTES,
  SEED_SYSTEM_ONE_PRICES,
  type SystemOneProvider,
  type TenantContext,
  allowAllLimiter,
  allowAllQuota,
  createMemoryActionRegistry,
  createMemoryModelCatalog,
  createMemoryPriceBook,
  createMemoryRunSink,
  staticKeyResolver,
} from "@bandwise/core";
import { FixtureTransport, loadBundledFixtures } from "@bandwise/system-one-client/fixture";

/** The org every local run belongs to. Nothing is stored anywhere. */
export const LOCAL_ORG_ID = "00000000-0000-7000-8000-00000000c0de";

export const LOCAL_CONTEXT: TenantContext = {
  orgId: LOCAL_ORG_ID,
  actor: { type: "user", userId: "00000000-0000-7000-8000-00000000c0df", role: "owner", platformRole: null, impersonatorId: null },
  client: "cli",
  plan: "local",
  requestId: "local",
};

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
  const ports: RunPorts = {
    systemOne: transport,
    models: createMemoryModelCatalog(SEED_MODEL_PROFILES, SEED_MODEL_ROUTES),
    // Local mode sends nothing anywhere, so the key is a placeholder that never leaves the process.
    keys: staticKeyResolver({ typesafe: "local-fixture", openrouter: "local-fixture", vercel: "local-fixture" }),
    limiter: allowAllLimiter,
    quota: allowAllQuota,
    runs: createMemoryRunSink(newId),
    actions: createMemoryActionRegistry(),
    prices: createMemoryPriceBook([...SEED_SYSTEM_ONE_PRICES, ...SEED_COMPARATOR_PRICES]),
    clock: now,
    newId,
  };
  return { ports, transport };
}
