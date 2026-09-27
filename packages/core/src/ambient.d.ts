// Core builds with no environment types (tsconfig.build.json has `types: []`), so process, Buffer,
// timers and fetch do not typecheck in core sources. The port contracts still name AbortSignal,
// which only Node and DOM declare. This declares the one member core reads. It merges with the
// Node or DOM declaration wherever those are loaded, and it is not emitted, so consumers see
// their own AbortSignal.
interface AbortSignal {
  readonly aborted: boolean;
}
