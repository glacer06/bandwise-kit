// FixtureTransport: replays fixtures and never touches the network (SYSTEM_ONE_TRANSPORT=fixture,
// unit tests, CI, `bandwise run --local`). It never imports @typesafe-ai/sdk.

import {
  type SystemOneCallOptions,
  type SystemOneCallResult,
  type SystemOneProvider,
  type SystemOneRequest,
  type SystemOneTransport,
  TransportError,
} from "@bandwise/core";
import { type Fixture, fixtureKey } from "./fixture.js";
import { assertNotEvaluationFallback } from "./fallback-guard.js";
import { transportErrorForStatus } from "./status-map.js";
import { syntheticResponse } from "./synthetic.js";

export interface FixtureTransportOptions {
  /**
   * Answer requests no fixture covers with deterministic synthetic answers instead of failing.
   * For local runs of your own specs; never for contract tests.
   */
  synthesize?: boolean;
  /** The id a synthetic response reports as `model`, for example an alias's target. Default: the id sent. */
  resolveModel?: (sentModel: string, provider: SystemOneProvider) => string;
}

export interface FixtureCall {
  request: SystemOneRequest;
  provider: SystemOneProvider;
  /** The fixture that answered, or null for a synthetic answer. */
  fixture: string | null;
}

export class FixtureTransport implements SystemOneTransport {
  private readonly byKey = new Map<string, Fixture>();
  /** Every call, in order. Replay tests assert on its length. */
  readonly calls: FixtureCall[] = [];

  constructor(
    fixtures: readonly Fixture[],
    private readonly options: FixtureTransportOptions = {},
  ) {
    for (const f of fixtures) this.byKey.set(fixtureKey(f.provider, f.request), f);
  }

  /** Number of fixtures loaded. */
  get size(): number {
    return this.byKey.size;
  }

  /** True when a fixture answers this request on this provider. */
  has(provider: SystemOneProvider, request: SystemOneRequest): boolean {
    return this.byKey.has(fixtureKey(provider, request));
  }

  async call(req: SystemOneRequest, opts: SystemOneCallOptions): Promise<SystemOneCallResult> {
    if (opts.signal.aborted) {
      throw new TransportError({ code: "client_aborted", retryable: false, requestId: null }, "the call was aborted");
    }
    const fixture = this.byKey.get(fixtureKey(opts.provider, req));
    this.calls.push({ request: req, provider: opts.provider, fixture: fixture?.name ?? null });
    if (fixture === undefined) {
      if (this.options.synthesize !== true) {
        throw new TransportError(
          { code: "system_one_invalid_request", retryable: false, requestId: null },
          `no fixture for this ${opts.provider} request (key ${fixtureKey(opts.provider, req).slice(0, 12)})`,
        );
      }
      const model = this.options.resolveModel?.(req.model, opts.provider) ?? req.model;
      return { response: syntheticResponse(req, model), requestId: null };
    }
    if ("error" in fixture) {
      const requestId = fixture.error.headers?.["x-typesafe-request-id"] ?? fixture.requestId ?? null;
      throw transportErrorForStatus(fixture.error.status, opts.provider, requestId);
    }
    const requestId = fixture.requestId ?? fixture.response.id ?? null;
    // Same guard as SdkTransport, so an evaluation fallback fixture fails the way a live one would.
    assertNotEvaluationFallback(fixture.response, opts.provider, requestId, fixture.responseHeaders);
    return { response: fixture.response, requestId };
  }
}
