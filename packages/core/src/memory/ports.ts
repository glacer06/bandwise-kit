// In-memory RunPorts for tests, fixtures and `bandwise run --local`.
// Pure: no I/O, no clock, no randomness.

import type {
  ActionJob,
  ActionRegistry,
  EffectiveModel,
  KeyResolver,
  ModelCatalog,
  ModelPrice,
  PriceBook,
  QuotaGuard,
  RateLimiter,
  RunSink,
  RunSinkRecord,
} from "../contracts/ports.js";
import type { ModelProfile, ModelRoute } from "../contracts/models.js";
import { resolveRoute } from "../contracts/models.js";
import { TransportError } from "../contracts/ports.js";
import type { SystemOneProvider } from "../contracts/system-one.js";

/**
 * A ModelCatalog over fixed rows. A moving name (an alias row) resolves to the profile of its
 * aliasTarget, the last observed versioned model; its route and pinning come from its own row.
 */
export function createMemoryModelCatalog(
  profiles: readonly ModelProfile[],
  routes: readonly ModelRoute[] = [],
): ModelCatalog {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return {
    async get(id) {
      return byId.get(id) ?? null;
    },
    async routes(provider) {
      return provider === "typesafe" ? [] : routes.filter((r) => r.provider === provider);
    },
    async effective(name, provider): Promise<EffectiveModel> {
      const own = byId.get(name) ?? null;
      if (own === null) {
        return { profile: null, pinned: false, resolvedId: null, provider, providerModelId: null, limits: null };
      }
      const target = own.kind === "alias" && own.aliasTarget !== null ? (byId.get(own.aliasTarget) ?? null) : own;
      const profile = target ?? own;
      const route = resolveRoute({ id: own.id, kind: own.kind, limits: profile.limits }, provider, routes);
      return {
        profile,
        pinned: route?.pinned ?? false,
        resolvedId: own.kind === "versioned" ? own.id : (own.aliasTarget ?? null),
        provider,
        providerModelId: route?.providerModelId ?? null,
        limits: route?.limits ?? null,
      };
    },
  };
}

/** One price row: an exact model id, optionally for one provider and one org. */
export interface MemoryPriceRow extends ModelPrice {
  model: string;
  provider?: SystemOneProvider;
  orgId?: string;
}

/** A PriceBook: the org row first, then the platform row; a provider row beats a provider-independent one. */
export function createMemoryPriceBook(rows: readonly MemoryPriceRow[]): PriceBook {
  return {
    async get(orgId, modelId, provider) {
      const candidates = rows.filter(
        (r) =>
          r.model === modelId &&
          (r.provider === undefined || r.provider === provider) &&
          (r.orgId === undefined || r.orgId === orgId),
      );
      const rank = (r: MemoryPriceRow): number => (r.orgId === undefined ? 2 : 0) + (r.provider === undefined ? 1 : 0);
      const best = candidates.sort((a, b) => rank(a) - rank(b))[0];
      return best === undefined ? null : { inputPerMtokMicroUsd: best.inputPerMtokMicroUsd, outputPerMtokMicroUsd: best.outputPerMtokMicroUsd };
    },
  };
}

/** A RunSink that keeps records in memory and creates one review item id per `review` decision. */
export interface MemoryRunSink extends RunSink {
  readonly records: RunSinkRecord[];
}

export function createMemoryRunSink(newId: () => string): MemoryRunSink {
  const records: RunSinkRecord[] = [];
  return {
    records,
    async persist(_ctx, record) {
      records.push(record);
      const challenger = record.result.experiment?.arm === "challenger";
      const reviewItemIds = challenger
        ? []
        : Object.values(record.result.decisions)
            .filter((d) => d.effectiveAction === "review")
            .map(() => newId());
      return { reviewItemIds, labelItemIds: [] };
    },
  };
}

/** A limiter that always allows. */
export const allowAllLimiter: RateLimiter = async () => ({ ok: true });

/** A quota guard that always allows. */
export const allowAllQuota: QuotaGuard = async () => ({ ok: true });

/** An ActionRegistry that records enqueued jobs. Handlers in `enabled` are enabled. */
export interface MemoryActionRegistry extends ActionRegistry {
  readonly jobs: ActionJob[];
}

export function createMemoryActionRegistry(enabled: readonly string[] = []): MemoryActionRegistry {
  const jobs: ActionJob[] = [];
  return {
    jobs,
    async isEnabled(_orgId, handlerId) {
      return enabled.includes(handlerId);
    },
    async enqueue(job) {
      jobs.push(job);
    },
  };
}

/** A KeyResolver that returns one fixed key per provider. */
export function staticKeyResolver(keys: Partial<Record<SystemOneProvider, string>>, mode: "byo" | "platform" = "byo"): KeyResolver {
  return async (_ctx, provider) => {
    const apiKey = keys[provider];
    if (apiKey === undefined) {
      throw new TransportError({ code: "system_one_auth", retryable: false, requestId: null }, "no key for this provider");
    }
    return { apiKey, mode, provider };
  };
}

/** A clock that advances by `stepMs` on every read, from `startMs`. */
export function steppingClock(startMs = 1_790_000_000_000, stepMs = 5): () => number {
  let t = startMs - stepMs;
  return () => (t += stepMs);
}

/** Deterministic uuid-shaped ids: 00000000-0000-7000-8000-000000000001 and up. */
export function sequentialIds(prefix = "00000000-0000-7000-8000-"): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(12, "0")}`;
}
