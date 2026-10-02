import { defineTemplate } from "../types.js";

export const launchProfile = defineTemplate({
  id: "launch-profile",
  title: "Launch profile",
  job: "Pick a launch profile for a coding agent session before it starts, from a list the host has approved.",
  pattern: "intent_routing",
  whenToUse: [
    "A host starts coding agent sessions, such as Claude Code, and can set the model and effort at launch but not change them mid-session.",
    "Many tasks are mechanical and a few need the strongest model, and you want the pick made once, before the first turn, from profiles you have reviewed.",
  ],
  whenNotToUse: [
    "The session is already running. A hook inside it cannot change its model; use model-tier for advice instead.",
    "The task names the model or the effort itself. Read it in code.",
    "You want the set to return a model name or a flag. It only picks a profile id; the host maps the id to a model and effort from its own reviewed file.",
  ],
  notes: [
    "The answer is a profile id: `light`, `standard`, `deep` or `deep_review`. The host keeps a reviewed profiles file that maps each id to one or two sessions, each with a model and an effort, plus a default. The set never names a model or a flag.",
    "`unclear` is not a profile id, so it resolves to the default, as does any answer that is not a profile id in the host's file. So do an outage, an error or a timeout: a Bandwise problem never stops a session from starting.",
    "Start in `shadow`: the host always launches the default and records what the set would have picked. In `controlled` only a high band pick is used.",
    "A wrong `light` costs the most (a weaker model on a hard task), so it needs a higher bar than the other options.",
    "`deep_review` names a second session for an independent review. Whether a host starts it is the host's decision; `bandwise launch --print` only reports it.",
    "Outage rule: `onUnavailable` is `review`. During a System One outage the host launches the default.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", maxLength: 8000 },
        },
      },
    },
    stages: [
      {
        id: "pick",
        questions: {
          profile: {
            type: "choice",
            instructions: {
              question:
                "A developer is about to start a coding agent session in their repository with this task. Which launch profile fits it best?",
              developer_task: "`task`",
            },
            criteria: {
              light:
                "Mechanical work with every detail given and no design choice: rename a symbol, format files, move files, bump a version, run a given command, make a small edit spelled out in full, or find where something is defined.",
              standard:
                "Normal work with a clear goal in ordinary product code: build a described feature, fix a bug whose cause is known or easy to find, write tests for existing code, or refactor one module.",
              deep: "Work that needs design or investigation: choose an architecture, debug a failure whose cause is unknown, change code across many parts of the system, or settle a goal that is vague or open to several readings.",
              deep_review:
                "Deep work where a subtle mistake is costly, so an independent review of the result is worth a second session: authentication, permissions, secrets, payments, data deletion or migrations, production infrastructure, or a security fix.",
              unclear: "The task is too short or vague to tell what it needs, such as a single word or a greeting.",
            },
            meta: { label: "Launch profile" },
          },
        },
      },
    ],
    policies: {
      profile: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.7, medium: 0.4 },
        perOption: { light: { high: 0.8, medium: 0.5 } },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    },
    routes: [
      { when: { q: "profile", eq: "light" }, output: "light" },
      { when: { q: "profile", eq: "deep" }, output: "deep" },
      { when: { q: "profile", eq: "deep_review" }, output: "deep_review" },
    ],
    defaultRoute: "standard",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 30, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Rename across the repo",
      expect: "light: every detail is given and nothing needs a design choice.",
      state: { task: "Rename the function getUserName to getDisplayName everywhere, including the tests. No other changes." },
    },
    {
      name: "Described feature",
      expect: "standard: a clear feature in ordinary product code.",
      state: {
        task: "Add a Download CSV button to the invoices table. It should export the rows currently shown, with the same columns, and use the existing toCsv helper in src/lib/csv.ts.",
      },
    },
    {
      name: "Intermittent failure in the auth flow",
      expect: "deep_review: the cause is unknown and the code decides who can sign in.",
      state: {
        task: "About one in twenty sign-ins fail with a 401 right after the token refresh, only in production. Find out why and fix it.",
      },
    },
  ],
  borderline: {
    profile: {
      why: "A small, well-described edit that still needs one judgment call about where the check belongs: light or standard.",
      state: {
        task: "The settings page crashes when the user has no avatar. Add a null check so it shows the initials instead.",
      },
    },
  },
});
