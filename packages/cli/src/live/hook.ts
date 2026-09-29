// `bandwise hook <event> --set <path>`: a Claude Code hook backed by a question set.
//
// It reads Claude Code's hook JSON on stdin, maps it to the fields the set's input schema names
// (redacted and cut to maxLength), runs the set live, appends a receipt, and prints hook JSON only
// when the set may act. In `shadow` it never blocks, denies or adds context. In `controlled` only a
// high band answer acts (core's effective action). Any error or a timeout (3 seconds by default)
// ends with exit 0 and no output, so a hook never breaks a session.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { RunResult, SystemOneProvider, SystemOneTransport } from "@bandwise/core";
import { type Receipt, appendReceipt, specHash } from "../receipts/index.js";
import { loadSpec } from "../runner/index.js";
import { readProviderKey } from "./key.js";
import { failureReceipt } from "./receipt-from-result.js";
import { shapeState } from "./redact.js";
import { runLiveSpec, setSlug } from "./run-live.js";

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

export interface HookCommand {
  event: HookEvent;
  setPath: string;
  rollout: HookRollout;
  provider: SystemOneProvider;
  timeoutMs: number;
  receiptsPath: string;
  /** Input fields never to send, on top of the schema filter. */
  drop: string[];
}

export interface HookDeps {
  stdin: () => Promise<string>;
  env?: Readonly<Record<string, string | undefined>>;
  transport: () => SystemOneTransport;
  now?: () => number;
  /** Tests replace the receipt writer. */
  writeReceipt?: (path: string, receipt: Receipt) => void;
  /** Tests replace the transcript reader. */
  readTranscript?: (path: string) => string;
}

export interface HookOutput {
  exitCode: 0;
  stdout: string;
}

const SILENT: HookOutput = { exitCode: 0, stdout: "" };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** Most bytes of a transcript read from its end. Long sessions write large files. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function readTail(path: string): string {
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

type Mapped = { kind: "skip" } | { kind: "run"; candidate: Record<string, unknown> };

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
  const fromTranscript = path === undefined ? { request: undefined, lastReply: undefined } : lastExchange(readTranscript(path));
  const lastReply = direct ?? fromTranscript.lastReply;
  if (fromTranscript.request === undefined || lastReply === undefined) return { kind: "skip" };
  return { kind: "run", candidate: { request: fromTranscript.request, last_reply: lastReply } };
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

/** Run one hook call. Never throws and never exits non-zero. */
export async function runHook(cmd: HookCommand, deps: HookDeps): Promise<HookOutput> {
  const now = deps.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, cmd.timeoutMs);
  });
  const write = deps.writeReceipt ?? appendReceipt;
  // After a timeout the run may still finish in the background; it writes nothing then.
  let settled = false;
  const record = (receipt: Receipt): void => {
    if (settled) return;
    try {
      write(cmd.receiptsPath, receipt);
    } catch {
      // A receipt that cannot be written never breaks the session.
    }
  };
  let meta: { set: string; specHash: string; modelRequested: string } | null = null;

  const work = async (): Promise<HookOutput> => {
    // No key, no call and no receipt: the hook is simply off.
    if (!readProviderKey(cmd.provider, deps.env).ok) return SILENT;
    const loaded = loadSpec(cmd.setPath);
    if (!loaded.ok) return SILENT;
    meta = { set: setSlug(cmd.setPath), specHash: specHash(loaded.value.text), modelRequested: loaded.value.spec.model };
    const raw: unknown = JSON.parse(await deps.stdin());
    if (!isObj(raw)) return SILENT;
    const mapped = mapHookInput(cmd.event, raw, deps.readTranscript ?? readTail);
    if (mapped.kind === "skip") return SILENT;
    const state = shapeState(mapped.candidate, loaded.value.spec.input.schema, cmd.drop);
    const outcome = await runLiveSpec(
      { spec: loaded.value, set: meta.set, state, provider: cmd.provider, rollout: cmd.rollout, source: cmd.event, signal: controller.signal },
      { ...(deps.env !== undefined ? { env: deps.env } : {}), transport: deps.transport(), now },
    );
    if (!outcome.ok) {
      record(failureReceipt({ ...meta, source: cmd.event, provider: cmd.provider, at: new Date(now()).toISOString(), acted: false, rollout: cmd.rollout, status: outcome.code, latencyMs: now() - started }));
      return SILENT;
    }
    const response = hookResponse(cmd.event, cmd.rollout, outcome.result);
    record(outcome.receipt(response !== null));
    return response === null ? SILENT : { exitCode: 0, stdout: JSON.stringify(response) };
  };

  try {
    const winner = await Promise.race([work(), timedOut]);
    if (winner === "timeout") {
      const m = meta as { set: string; specHash: string; modelRequested: string } | null;
      if (m !== null) {
        record(failureReceipt({ ...m, source: cmd.event, provider: cmd.provider, at: new Date(now()).toISOString(), acted: false, rollout: cmd.rollout, status: "timeout", latencyMs: now() - started }));
      }
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
