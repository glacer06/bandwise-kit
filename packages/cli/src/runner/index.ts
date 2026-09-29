// The shared runner of @bandwise/cli: spec loading and one run through core. Imports core only;
// local mode and live mode each bring their own transport.

export { CLI_CONTEXT, CLI_ORG_ID, type LoadedSpec, type ReadResult, type Refusal, type RunSpecOptions, type RunSpecOutcome, loadSpec, readJsonFile, runSpec } from "./run-spec.js";
export { basePorts } from "./ports.js";
