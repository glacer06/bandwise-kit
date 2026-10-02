// The local receipt: one line per live run in ~/.bandwise/receipts.jsonl. It holds what a
// run decided and what it cost, never the prompt, the state or a tool input. This file imports no
// workspace package, so `bandwise report` works without core.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const RECEIPT_SCHEMA_VERSION = 1;

export type Band = "high" | "medium" | "low";

export interface ReceiptDecision {
  /** choice key, score, true or false, a composite value, or null. Never free text from the state. */
  value: string | number | boolean | null;
  band: Band;
  action: string;
  effectiveAction: string;
  relevant: boolean;
}

/**
 * What one Claude Code task looked like, on a Stop receipt. Counts and times only, taken
 * from the session transcript: never a prompt, a reply or a tool input. Subagent (sidechain) turns
 * are not counted.
 */
export interface ReceiptSession {
  /** FNV-1a of Claude Code's session id. Groups the stops of one session and names nothing. */
  key: string;
  /** Wall time from the user's request to this stop. Null when the request's time is not in the transcript read. */
  taskMs: number | null;
  /** Agent turns (assistant messages) since the request. */
  turns: number;
  /** Tool calls since the request. */
  toolCalls: number;
  /** The launch profile the session started with, and the one the launch-profile set picked. Null outside `bandwise launch`. */
  profile: string | null;
  profilePicked: string | null;
}

export interface Receipt {
  v: typeof RECEIPT_SCHEMA_VERSION;
  /** ISO time the run finished. */
  at: string;
  /** Set slug: the spec file name without `.json`. */
  set: string;
  /** Hash of the spec file, so a receipt names the exact spec that ran. */
  specHash: string;
  /** What asked for the run: `run`, or the Claude Code hook event such as `Stop`. */
  source: string;
  provider: string;
  rollout: string;
  /** `ok`, a run error code, `timeout` or `error`. */
  status: string;
  modelRequested: string;
  modelResolved: string | null;
  route: string | null;
  runBand: Band | null;
  overallAction: string | null;
  decisions: Record<string, ReceiptDecision>;
  /** Whether the hook changed anything in the session. Always false in shadow. */
  acted: boolean;
  systemOneCostUsd: number | null;
  counterfactualLlmCostUsd: number;
  comparatorModel: string | null;
  savingsUsd: number;
  savingsSuppressed: string | null;
  latencyMs: number;
  /** Only on Stop receipts from `bandwise hook`. Receipts from older CLIs have none. */
  session?: ReceiptSession;
  /** Only on receipts from `bandwise launch`: the profile used and the one the set picked (null for none). */
  launch?: { profile: string; picked: string | null };
  /**
   * Only on receipts from a hook that called the hosted endpoint (BANDWISE_TOKEN set): the host,
   * and the version, channel and run id the server reported (null when no run came back).
   */
  remote?: { host: string; version: number | null; channel: string | null; runId: string | null };
}

/** Where receipts go when no path is given. */
export function defaultReceiptsPath(home: string = homedir()): string {
  return join(home, ".bandwise", "receipts.jsonl");
}

/** Append one receipt as a line. Creates the folder the first time. */
export function appendReceipt(path: string, receipt: Receipt): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** True when a parsed line looks like a receipt this version can read. */
export function isReceipt(x: unknown): x is Receipt {
  return (
    isObj(x) &&
    x["v"] === RECEIPT_SCHEMA_VERSION &&
    typeof x["at"] === "string" &&
    typeof x["set"] === "string" &&
    typeof x["status"] === "string" &&
    isObj(x["decisions"]) &&
    typeof x["counterfactualLlmCostUsd"] === "number" &&
    typeof x["latencyMs"] === "number"
  );
}

/** Read every receipt in a file. A missing file is no receipts; unreadable lines are counted, not fatal. */
export function readReceipts(path: string): { receipts: Receipt[]; skipped: number } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { receipts: [], skipped: 0 };
  }
  const receipts: Receipt[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isReceipt(parsed)) receipts.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { receipts, skipped };
}

/**
 * FNV-1a over the spec text, 64 bits as hex. Enough to tell two spec versions apart; not a
 * security hash (the CLI stays off node:crypto, which only tenancy may import).
 */
export function specHash(text: string): string {
  return fnv1a64(text);
}

/** FNV-1a, 64 bits, as `fnv1a64:<hex>`. Used for spec hashes and session keys. */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  }
  return `fnv1a64:${h.toString(16).padStart(16, "0")}`;
}
