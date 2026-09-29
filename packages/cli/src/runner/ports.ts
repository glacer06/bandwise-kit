// RunPorts shared by local and live mode: core's in-memory ports, the seed model registry and the
// seed price book. The caller supplies the transport and the key resolver.

import {
  type KeyResolver,
  type RunPorts,
  SEED_COMPARATOR_PRICES,
  SEED_MODEL_PROFILES,
  SEED_MODEL_ROUTES,
  SEED_SYSTEM_ONE_PRICES,
  type SystemOneTransport,
  allowAllLimiter,
  allowAllQuota,
  createMemoryActionRegistry,
  createMemoryModelCatalog,
  createMemoryPriceBook,
  createMemoryRunSink,
} from "@bandwise/core";

/** Ports for one CLI run. `now` and `newId` come from the caller, so tests can fix them. */
export function basePorts(transport: SystemOneTransport, keys: KeyResolver, now: () => number, newId: () => string): RunPorts {
  return {
    systemOne: transport,
    models: createMemoryModelCatalog(SEED_MODEL_PROFILES, SEED_MODEL_ROUTES),
    keys,
    limiter: allowAllLimiter,
    quota: allowAllQuota,
    runs: createMemoryRunSink(newId),
    actions: createMemoryActionRegistry(),
    prices: createMemoryPriceBook([...SEED_SYSTEM_ONE_PRICES, ...SEED_COMPARATOR_PRICES]),
    clock: now,
    newId,
  };
}
