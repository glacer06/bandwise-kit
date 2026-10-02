// The parts of `bandwise hook` that never call a model: mapping Claude Code's hook input to set
// fields, the transcript readers, the shaped state and the hook answer. Live mode (hook.ts) and
// hosted mode (hook-remote.ts) share them. Core is imported for types only, so hosted mode loads
// neither core nor the SDK.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { RunResult } from "@bandwise/core";
import { type Receipt, type ReceiptSession, appendReceipt, fnv1a64 } from "../receipts/index.js";
import { readLaunchProfile } from "./key.js";
import { shapeState } from "./redact.js";

export const HOOK_EVENTS = ["Stop", "PreToolUse", "UserPromptSubmit"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_ROLLOUTS = ["shadow", "controlled", "full"] as const;
export type HookRollout = (typeof HOOK_ROLLOUTS)[number];

export const DEFAULT_HOOK_TIMEOUT_MS = 3_000;

/** Tools the risk gate looks at. Other tools pass through without a call. */
export const GATED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

/**
 * Shell commands the risk gate never sends: plain reads with no redirection, chaining or
 * substitution. They cost a call and cannot do damage (the template notes say to skip them).
 */
const TRUSTED_COMMAND = /^\s*(?:ls|pwd|cat|head|tail|wc|grep|rg|find|which|echo|git\s+(?:status|diff|log|show|branch|rev-parse|remote\s+-v))(?:\s|$)/;
const SHELL_CONTROL = /[;&|<>`$]|\bexec\b|-delete\b|-exec\b/;

export function isTrustedCommand(command: string): boolean {
  return TRUSTED_COMMAND.test(command) && !SHELL_CONTROL.test(command);
}

export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
export const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** Most bytes of a transcript read from its end. Long sessions write large files. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

export function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => isObj(b) && b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The last thing the user typed and the agent's final text, from a Claude Code transcript (JSONL).
 * Tool results and meta lines are not user requests.
 */
export function lastExchange(transcript: string): { request: string | undefined; lastReply: string | undefined } {
  let request: string | undefined;
  let lastReply: string | undefined;
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // The first line of a tail read is usually cut.
    }
    if (!isObj(entry) || !isObj(entry["message"]) || entry["isMeta"] === true || entry["isSidechain"] === true) continue;
    const text = textOf(entry["message"]["content"]).trim();
    if (text === "") continue;
    if (entry["type"] === "user") {
      request = text;
      lastReply = undefined;
    } else if (entry["type"] === "assistant") {
      lastReply = text;
    }
  }
  return { request, lastReply };
}

/** Counts for the task behind a Stop: since the user's last typed request. */
export interface TaskStats {
  /** Epoch ms of the request, from the transcript's timestamp. Null when it has none. */
  requestAt: number | null;
  turns: number;
  toolCalls: number;
}

/**
 * Turns and tool calls since the last typed request in a Claude Code transcript. A turn is
 * one assistant message; Claude Code writes a line per content block, so lines that share a
 * message id count once. Subagent (sidechain) lines are not counted. Null when no request is in
 * the text read.
 */
export function taskStats(transcript: string): TaskStats | null {
  let stats: TaskStats | null = null;
  let ids = new Set<string>();
  let unnamed = 0;
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(entry) || !isObj(entry["message"]) || entry["isMeta"] === true || entry["isSidechain"] === true) continue;
    const content = entry["message"]["content"];
    if (entry["type"] === "user") {
      if (textOf(content).trim() === "") continue; // A tool result, not a request.
      const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : Number.NaN;
      stats = { requestAt: Number.isNaN(at) ? null : at, turns: 0, toolCalls: 0 };
      ids = new Set();
      unnamed = 0;
    } else if (entry["type"] === "assistant" && stats !== null) {
      const id = str(entry["message"]["id"]);
      if (id === undefined) unnamed++;
      else ids.add(id);
      stats.turns = ids.size + unnamed;
      if (Array.isArray(content)) stats.toolCalls += content.filter((b) => isObj(b) && b["type"] === "tool_use").length;
    }
  }
  return stats;
}

type Mapped = { kind: "skip" } | { kind: "run"; candidate: Record<string, unknown>; task?: TaskStats };

/** Map Claude Code's hook input to candidate fields for the set. The schema filter runs after. */
export function mapHookInput(event: HookEvent, input: Record<string, unknown>, readTranscript: (path: string) => string): Mapped {
  if (event === "UserPromptSubmit") {
    const prompt = str(input["prompt"]);
    return prompt === undefined || prompt.trim() === "" ? { kind: "skip" } : { kind: "run", candidate: { prompt } };
  }
  if (event === "PreToolUse") {
    const tool = str(input["tool_name"]);
    if (tool === undefined || !(GATED_TOOLS as readonly string[]).includes(tool)) return { kind: "skip" };
    const ti = isObj(input["tool_input"]) ? input["tool_input"] : {};
    const command = str(ti["command"]);
    if (tool === "Bash" && (command === undefined || isTrustedCommand(command))) return { kind: "skip" };
    const edits = Array.isArray(ti["edits"]) ? ti["edits"].map((e) => (isObj(e) ? (str(e["new_string"]) ?? "") : "")).join("\n") : undefined;
    const preview = str(ti["content"]) ?? str(ti["new_string"]) ?? str(ti["new_source"]) ?? edits;
    return {
      kind: "run",
      candidate: {
        tool,
        command,
        file_path: str(ti["file_path"]) ?? str(ti["notebook_path"]),
        content_preview: preview,
        description: str(ti["description"]),
      },
    };
  }
  // Stop. A stop that a Stop hook already sent back is let through, so the gate never loops.
  if (input["stop_hook_active"] === true) return { kind: "skip" };
  const direct = str(input["last_assistant_message"]);
  const path = str(input["transcript_path"]);
  const text = path === undefined ? "" : readTranscript(path);
  const fromTranscript = lastExchange(text);
  const lastReply = direct ?? fromTranscript.lastReply;
  if (fromTranscript.request === undefined || lastReply === undefined) return { kind: "skip" };
  const task = taskStats(text);
  return { kind: "run", candidate: { request: fromTranscript.request, last_reply: lastReply }, ...(task !== null ? { task } : {}) };
}

export type PreparedHook = { kind: "skip" } | { kind: "run"; state: Record<string, unknown>; session?: ReceiptSession };

/**
 * Read the hook JSON, map it, and shape the state the set may see. A Stop also gets its session
 * counts. Throws on hook input that is not JSON; the caller turns that into a silent exit.
 */
export function prepareHook(
  event: HookEvent,
  stdinText: string,
  inputSchema: unknown,
  drop: readonly string[],
  o: { started: number; env?: Readonly<Record<string, string | undefined>>; readTranscript?: (path: string) => string },
): PreparedHook {
  const raw: unknown = JSON.parse(stdinText);
  if (!isObj(raw)) return { kind: "skip" };
  const mapped = mapHookInput(event, raw, o.readTranscript ?? readTail);
  if (mapped.kind === "skip") return { kind: "skip" };
  const state = shapeState(mapped.candidate, inputSchema, drop);
  if (mapped.task === undefined) return { kind: "run", state };
  const launch = readLaunchProfile(o.env);
  const session: ReceiptSession = {
    key: fnv1a64(str(raw["session_id"]) ?? ""),
    taskMs: mapped.task.requestAt === null ? null : Math.max(0, o.started - mapped.task.requestAt),
    turns: mapped.task.turns,
    toolCalls: mapped.task.toolCalls,
    profile: launch.profile,
    profilePicked: launch.picked,
  };
  return { kind: "run", state, session };
}

export interface HookOutput {
  exitCode: 0;
  stdout: string;
}

export const SILENT: HookOutput = { exitCode: 0, stdout: "" };

export interface HookGuard {
  signal: AbortSignal;
  /** Append a receipt. A write that fails, or comes after a timeout, is dropped. */
  record: (receipt: Receipt) => void;
}

/**
 * Run hook work under its timeout. On a timeout the signal aborts, `onTimeout` may name a receipt,
 * and the hook ends silent. Work that finishes later writes nothing. Never throws.
 */
export async function guardHook(
  o: { timeoutMs: number; receiptsPath: string; writeReceipt?: (path: string, receipt: Receipt) => void },
  work: (g: HookGuard) => Promise<HookOutput>,
  onTimeout: () => Receipt | null,
): Promise<HookOutput> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, o.timeoutMs);
  });
  const write = o.writeReceipt ?? appendReceipt;
  let settled = false;
  const record = (receipt: Receipt): void => {
    if (settled) return;
    try {
      write(o.receiptsPath, receipt);
    } catch {
      // A receipt that cannot be written never breaks the session.
    }
  };
  try {
    const winner = await Promise.race([work({ signal: controller.signal, record }), timedOut]);
    if (winner === "timeout") {
      const receipt = onTimeout();
      if (receipt !== null) record(receipt);
      settled = true;
      return SILENT;
    }
    return winner;
  } catch {
    return SILENT;
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The hook JSON for a result that may act, or null. Only a set that is not in shadow ever acts. */
export function hookResponse(event: HookEvent, rollout: HookRollout, result: RunResult): Record<string, unknown> | null {
  if (rollout === "shadow" || result.status !== "ok" || result.overallAction !== "auto" || result.route === null) return null;
  const why = Object.entries(result.decisions)
    .filter(([, d]) => d.relevant && d.value !== null)
    .map(([id, d]) => `${id}: ${String(d.value)}`)
    .join(", ");
  if (event === "Stop" && result.route === "continue") {
    return { decision: "block", reason: `Bandwise done-check (${why}). The request is not finished or a claim is unchecked. Finish the work or run the check, then say what you ran.` };
  }
  if (event === "PreToolUse" && result.route === "ask") {
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `Bandwise action-risk-gate flagged this call (${why}).` },
    };
  }
  if (event === "UserPromptSubmit" && result.route === "mechanical") {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Bandwise model-tier: this task looks mechanical. Hand bulk edits and lookups to a subagent on a smaller, cheaper model where you can.",
      },
    };
  }
  return null;
}
