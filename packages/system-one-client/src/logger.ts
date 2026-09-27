// The scrubbing logger every SDK client gets.
// The SDK redacts credential headers but not bodies, and bodies carry tenant state,
// so this logger keeps only the scrubbed message text and drops every structured value.

/** The SDK's Logger shape (console-compatible). */
export interface SdkLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Where scrubbed lines go. Defaults to console.warn and console.error. */
export interface LogSink {
  warn(line: string): void;
  error(line: string): void;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk_live_|sk_test_|pk_live_|sa_live_)[A-Za-z0-9_-]+/g,
  /\bsk-or-v1-[A-Za-z0-9]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // Long opaque tokens: API keys and similar secrets.
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** Replace key material and bearer tokens in a line with [redacted]. */
export function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, "[redacted]"), text);
}

const consoleSink: LogSink = {
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/**
 * A logger for TypeSafeClient. Debug and info are dropped (the client is built with logLevel warn
 * anyway); warn and error keep only the scrubbed message and a count of dropped values.
 */
export function createScrubbingLogger(sink: LogSink = consoleSink): SdkLogger {
  const line = (message: string, args: unknown[]): string =>
    `[system-one] ${scrub(String(message))}${args.length > 0 ? ` (${args.length} values dropped)` : ""}`;
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, ...args) => sink.warn(line(message, args)),
    error: (message, ...args) => sink.error(line(message, args)),
  };
}
