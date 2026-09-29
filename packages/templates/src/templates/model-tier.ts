import { defineTemplate } from "../types.js";

export const modelTier = defineTemplate({
  id: "model-tier",
  title: "Model tier",
  job: "Decide how hard a new request to a coding agent is, so mechanical work can go to a cheaper model or subagent.",
  pattern: "intent_routing",
  whenToUse: [
    "A coding agent runs every request on its largest model, and many requests are mechanical: renames, formatting, moving files, running a command, finding where something lives.",
    "The agent can hand work to a subagent or a cheaper model, and you want advice on when to do it before the first turn starts.",
  ],
  whenNotToUse: [
    "The agent cannot pick a model per task. Advice it cannot act on only adds tokens.",
    "You need a plan or an estimate for the task. That is text generation and takes longer than 10 seconds.",
    "The request names the model or the tier itself. Read it in code.",
  ],
  notes: [
    "Routes: `mechanical` (hand it to a cheaper model or subagent), `standard` (normal work on the default model) and `hard` (keep the strongest model and plan before editing).",
    "The hook only adds advice to the agent's context. It cannot switch the session's own model. Give advice only when `overallAction` is `auto`, and add nothing for `standard`, so the common case costs no context.",
    "`hard` wins over `mechanical`: a one line change to an auth check is still `hard`, because `high_stakes` routes it there whatever its size.",
    "Start in `shadow`: the gate runs and logs the tier it would have advised, and the agent gets no advice. Move it to `controlled` after reading a week of results; there only high band answers add advice.",
    "A wrong `mechanical` costs the most (a weaker model on a hard task), so both questions gate it. If either is unsure, no advice is added.",
    "Outage rule: `onUnavailable` is `review`. During a System One outage no advice is added.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", maxLength: 8000 },
        },
      },
    },
    stages: [
      {
        id: "tier",
        questions: {
          difficulty: {
            type: "score",
            instructions: {
              question:
                "A developer sent this request to a coding agent working in their repository. How much judgment does doing it well take?",
              developer_request: "`prompt`",
            },
            criteria: [
              "Mechanical. The request says exactly what to change and needs no design choice: rename a symbol, format files, move files, bump a version, run a given command, make a small edit spelled out in full, or find where something is defined.",
              "Standard. Normal work with a clear goal: build a feature that is described, fix a bug whose cause is known or easy to find, write tests for existing code, or refactor one module.",
              "Hard. The request needs design or investigation: choose an architecture, debug a failure whose cause is unknown, change code across many parts of the system, or settle a goal that is vague or open to several readings.",
            ],
            meta: { label: "Difficulty" },
          },
          high_stakes: {
            type: "noul",
            instructions: {
              question:
                "Does this request to a coding agent touch code where a subtle mistake is costly, whatever the size of the change?",
              developer_request: "`prompt`",
            },
            criteria: {
              true: "It touches authentication, permissions, secrets, payments, data deletion or migrations, production infrastructure, or a security fix.",
              false: "It stays in ordinary product code, tests, docs, styling or tooling, where a mistake is caught by tests or review and is cheap to fix.",
            },
            meta: { label: "High stakes" },
          },
        },
      },
    ],
    policies: {
      difficulty: {
        type: "score",
        gating: true,
        thresholds: { high: 0.6, medium: 0.35 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
      high_stakes: {
        type: "noul",
        gating: true,
        noul: { trueAt: 0.75, falseAt: 0.2, reviewMargin: 0.1 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    },
    routes: [
      { when: { any: [{ q: "high_stakes", eq: true }, { q: "difficulty", eq: 2 }] }, output: "hard" },
      { when: { q: "difficulty", eq: 0 }, output: "mechanical" },
    ],
    defaultRoute: "standard",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 30, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Rename across the repo",
      expect: "mechanical: every detail is given and nothing needs a design choice.",
      state: { prompt: "Rename the function getUserName to getDisplayName everywhere, including the tests. No other changes." },
    },
    {
      name: "Described feature",
      expect: "standard: a clear feature in ordinary product code.",
      state: {
        prompt:
          "Add a Download CSV button to the invoices table. It should export the rows currently shown, with the same columns, and use the existing toCsv helper in src/lib/csv.ts.",
      },
    },
    {
      name: "Intermittent failure in the auth flow",
      expect: "hard: the cause is unknown and the code decides who can sign in.",
      state: {
        prompt:
          "About one in twenty sign-ins fail with a 401 right after the token refresh, only in production. Find out why and fix it.",
      },
    },
  ],
  borderline: {
    difficulty: {
      why: "A small, well-described edit that still needs one judgment call about where the check belongs.",
      state: {
        prompt: "The settings page crashes when the user has no avatar. Add a null check so it shows the initials instead.",
      },
    },
    high_stakes: {
      why: "A mechanical change inside a sensitive area: bumping a version in the payments package.",
      state: {
        prompt: "Bump the payment provider SDK from 14.2.0 to 14.2.1 in packages/payments and update the lockfile.",
      },
    },
  },
});
