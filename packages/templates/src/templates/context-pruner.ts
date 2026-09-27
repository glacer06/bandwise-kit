import { defineTemplate } from "../types.js";

const task = "Fix the failing test in src/billing/invoice.test.ts without changing the public API.";

export const contextPruner = defineTemplate({
  id: "context-pruner",
  title: "Context pruner",
  job: "Decide, item by item, whether an agent's context item still matters for the current task, and drop the rest unchanged.",
  pattern: "confidence_routing",
  whenToUse: [
    "An agent's context fills with old tool calls, tool results and messages, and you pay for every token on every step.",
    "You want to keep or drop whole items. Nothing gets reworded, so nothing gets distorted.",
  ],
  whenNotToUse: [
    "You want a summary of the dropped items. That is text generation; keep an LLM for it.",
    "Items are tiny and few. The saving will not cover the call.",
    "The rule is mechanical, such as dropping tool results older than a set number of steps. Keep that in code.",
  ],
  notes: [
    "One run per item. Drop an item only when `overallAction` is `auto` and `route` is `drop`. Every other outcome keeps it.",
    "The thresholds lean toward keeping: `falseAt` is low, so the model must be sure an item no longer matters before it goes.",
    "Pass `options.metadata.tokensBefore` and `tokensAfter` on the run to book context tokens saved.",
    "Keep the latest user message and the system prompt out of the candidates. Pin them in code.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["task", "item"],
        properties: {
          task: { type: "string", maxLength: 2000 },
          item: {
            type: "object",
            required: ["kind", "content"],
            properties: {
              kind: { type: "string", enum: ["tool_call", "tool_result", "message"] },
              content: { type: "string" },
            },
          },
        },
      },
    },
    stages: [
      {
        id: "prune",
        questions: {
          still_matters: {
            type: "noul",
            instructions:
              "An agent is working on `task`. Would the agent need `item` in its context to finish that task correctly?",
            criteria: {
              true: "The item holds facts, decisions, file contents, errors or instructions the agent still needs for the task.",
              false: "The item is finished business: superseded output, a dead end already abandoned, or chatter with nothing the task depends on.",
            },
            meta: { label: "Still matters" },
          },
        },
      },
    ],
    policies: {
      still_matters: {
        type: "noul",
        gating: true,
        noul: { trueAt: 0.7, falseAt: 0.15, reviewMargin: 0.1 },
        actions: {
          high: { kind: "auto" },
          medium: { kind: "fallback", config: { kind: "value", value: true } },
          low: { kind: "fallback", config: { kind: "value", value: true } },
        },
      },
    },
    routes: [{ when: { q: "still_matters", eq: false }, output: "drop" }],
    defaultRoute: "keep",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 20, kind: "context_pruned" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Current test failure output",
      expect: "keep: it is the error the agent is fixing.",
      state: {
        task,
        item: {
          kind: "tool_result",
          content: "FAIL src/billing/invoice.test.ts > totals include tax. Expected 118.00, received 100.00.",
        },
      },
    },
    {
      name: "Directory listing from an unrelated package",
      expect: "drop: the agent looked there and moved on.",
      state: {
        task,
        item: { kind: "tool_result", content: "packages/marketing-site: README.md, next.config.js, src/, public/" },
      },
    },
  ],
  borderline: {
    still_matters: {
      why: "An earlier version of the file the agent has since edited. Mostly superseded, but it shows what the public API looked like.",
      state: {
        task,
        item: {
          kind: "tool_result",
          content: "src/billing/invoice.ts (before edits): export function total(lines) { return sum(lines); }",
        },
      },
    },
  },
});
