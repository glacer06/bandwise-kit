// Model list and alias probe helpers. They replace the
// old drift helper. The registry sync job (Platform lane) calls them per org key.

import {
  SEED_PLATFORM_DEFAULT_MODEL,
  type SystemOneProvider,
  type SystemOneRequest,
  type SystemOneTransport,
  TransportError,
} from "@bandwise/core";
import { type SdkTransportOptions, createSdkClient, mapSdkError } from "./sdk-transport.js";

/** One entry of GET /v1/models (openapi.json ModelMetadata). */
export interface ModelCard {
  name: string;
  description: string;
  release_date: string;
}

/**
 * The names a key can send (GET /v1/models in TypeSafe's shape). Works on TypeSafe and on Vercel AI
 * Gateway, which implements it at /typesafe/v1/models; Vercel names are Vercel ids such
 * as `typesafe-ai/jev`. OpenRouter keys use OpenRouter's Models API instead
 * (openRouterSystemOneModelIds), because the SDK's models.list() fails there.
 */
export async function listModels(
  provider: SystemOneProvider,
  apiKey: string,
  opts: SdkTransportOptions & { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ModelCard[]> {
  if (provider === "openrouter") {
    throw new TransportError(
      { code: "system_one_invalid_request", retryable: false, requestId: null },
      "models.list() does not work on OpenRouter; read OpenRouter's Models API for OpenRouter keys",
    );
  }
  const client = createSdkClient(provider, apiKey, SEED_PLATFORM_DEFAULT_MODEL, opts);
  try {
    const request: { signal?: AbortSignal; timeout?: number } = {};
    if (opts.signal !== undefined) request.signal = opts.signal;
    if (opts.timeoutMs !== undefined) request.timeout = opts.timeoutMs;
    const cards = await client.models.list(request);
    return cards.map((c) => ({ name: c.name, description: c.description, release_date: c.release_date }));
  } catch (e) {
    throw mapSdkError(e, provider);
  }
}

/**
 * The System One ids in a body from OpenRouter's Models API (GET https://openrouter.ai/api/v1/models):
 * entries `typesafe/*` and `~typesafe/*`. Map them to registry ids through the route rows.
 */
export function openRouterSystemOneModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && (id.startsWith("typesafe/") || id.startsWith("~typesafe/")));
}

/** The one-noul request the nightly probe sends to an idle alias. */
export function aliasProbeRequest(model: string): SystemOneRequest {
  return {
    state: "Hello, this is a connectivity check.",
    model,
    questions: { probe: { type: "noul", instructions: "Is this text a greeting or a connectivity check?" } },
  };
}

export interface AliasObservation {
  requested: string;
  resolved: string;
  requestId: string | null;
  provider: SystemOneProvider;
}

/**
 * Ask a moving name which build answers it. `sendAs` is the id to send on the provider (the route's
 * providerModelId; the name itself on TypeSafe). The result is recorded like a run's observation.
 */
export async function probeAlias(
  transport: SystemOneTransport,
  input: { alias: string; sendAs?: string; provider: SystemOneProvider; apiKey: string; signal: AbortSignal; timeoutMs?: number },
): Promise<AliasObservation> {
  const { response, requestId } = await transport.call(aliasProbeRequest(input.sendAs ?? input.alias), {
    provider: input.provider,
    apiKey: input.apiKey,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 10_000,
    retry: { maxRetries: 1, maxRetryAfterMs: 5_000 },
  });
  return { requested: input.alias, resolved: response.model, requestId, provider: input.provider };
}
