// @bandwise/system-one-client/server: the two transports a bundled server route needs, and nothing
// that reads the package's own folders. The root and ./fixture entry points also export the
// fixture and contract loaders, which find their folders with new URL("../dir/", import.meta.url);
// a bundler (Next with Turbopack) tries to resolve those as modules and fails the build.
//
// The fixture transport from here has no recorded fixtures: with synthesize it answers every
// request with deterministic synthetic answers, which is what a local server needs without a key.

export { SdkTransport, type SdkTransportOptions } from "./sdk-transport.js";
export { FixtureTransport, type FixtureTransportOptions } from "./fixture/fixture-transport.js";
