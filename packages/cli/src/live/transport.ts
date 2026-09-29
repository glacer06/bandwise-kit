// The one CLI module that loads the SDK transport. Only `bandwise run --live` and
// `bandwise hook` reach it, through live/index.ts, which main.ts loads on demand. The SDK client
// sends the key only to the provider base URL constant in core (SYSTEM_ONE_PROVIDER_BASE_URLS).

import type { SystemOneTransport } from "@bandwise/core";
import { SdkTransport, type SdkTransportOptions } from "@bandwise/system-one-client";

/** Where the SDK's scrubbed warnings go. The CLI keeps them off stdout, which hooks read. */
const quiet: NonNullable<SdkTransportOptions["logSink"]> = { warn: () => undefined, error: () => undefined };

/** A fetch implementation for the SDK client. */
export type LiveFetch = NonNullable<SdkTransportOptions["fetch"]>;

/** A live transport. Tests pass `fetch` so no request leaves the process. */
export function liveTransport(options: { fetch?: LiveFetch } = {}): SystemOneTransport {
  const opts: SdkTransportOptions = { logSink: quiet, maxClients: 3 };
  if (options.fetch !== undefined) opts.fetch = options.fetch;
  return new SdkTransport(opts);
}
