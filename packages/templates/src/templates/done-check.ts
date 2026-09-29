import { defineTemplate } from "../types.js";

export const doneCheck = defineTemplate({
  id: "done-check",
  title: "Done check",
  job: "Decide whether a coding agent has really finished the request before it stops, or has work left or an unchecked claim.",
  pattern: "confidence_routing",
  whenToUse: [
    "A coding agent such as Claude Code stops early: it leaves steps undone, stops after a plan, or says a fix works without running anything.",
    "You can hook the moment the agent stops (the Claude Code `Stop` hook) and hand it the request and its final message.",
  ],
  whenNotToUse: [
    "You need to know whether the code is correct. That takes tests and a review, not a 10 second read of the final message.",
    "The task has an exact finish line code can check, such as a test command exiting 0. Check it in code.",
    "The agent runs unattended with no way to send it back to work. There is nothing to act on.",
  ],
  notes: [
    "Routes: `stop` lets the agent stop, `continue` sends it back with the answer as the reason. `turn_outcome` says which: `work_left` (parts of the request are undone) or `unverified` (it claims success without a check it ran).",
    "Send the agent back only when `route` is `continue` and `overallAction` is `auto`. Any other result lets it stop, so a doubtful gate never keeps an agent looping.",
    "Start in `shadow`: the gate runs and logs what it would have done, and the agent always stops as it would without the hook. Move it to `controlled` after reading a week of results; there only a high band answer sends the agent back.",
    "`unverified` has a stricter bar through `perOption`. It is the answer most likely to be a false alarm, and sending an agent back to rerun checks it already ran wastes a turn.",
    "The gate sees only the request and the final message, not the tool calls in between. A reply that says which test or command it ran and what it showed counts as checked. Ask the agent, in your project instructions, to name the checks it ran in its final message.",
    "Limit repeats in code: if the gate sent the agent back on the last stop of this turn, let it stop this time. Claude Code marks that case with `stop_hook_active`.",
    "Outage rule: `onUnavailable` is `review`. During a System One outage the agent stops as usual.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["request", "last_reply"],
        properties: {
          request: { type: "string", maxLength: 4000 },
          last_reply: { type: "string", maxLength: 8000 },
        },
      },
    },
    stages: [
      {
        id: "done",
        questions: {
          turn_outcome: {
            type: "choice",
            instructions: {
              question:
                "A coding agent is about to stop and hand control back to the user. Given what the user asked for and the agent's final message, where does the work stand?",
              user_request: "`request`",
              agent_final_message: "`last_reply`",
            },
            criteria: {
              finished:
                "Everything the request asked for is done, and any claim that code works is backed by a test, build or command the message says it ran. Also pick this when the request needed no check, such as a question answered, an explanation or a plan the user asked for.",
              unverified:
                "The message says the change is done or fixed, but the claim rests on expectation, such as \"this should work now\", with no test, build or command it ran to show it.",
              work_left:
                "Parts of the request are still undone: the message lists next steps it has not taken, leaves TODOs, covers only some of the items asked for, or stops after a plan when the request asked for the change itself.",
              waiting_on_user:
                "The message asks the user a question it needs answered to go on, or names something only the user can give, such as credentials, access, an approval or a product decision. Asking permission to do work the request already asked for belongs under work_left.",
              unclear: "The message does not say enough to tell where the work stands.",
            },
            meta: { label: "Where the work stands" },
          },
        },
      },
    ],
    policies: {
      turn_outcome: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.7, medium: 0.4 },
        perOption: { unverified: { high: 0.8, medium: 0.5 } },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    },
    routes: [{ when: { q: "turn_outcome", in: ["work_left", "unverified"] }, output: "continue" }],
    defaultRoute: "stop",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 40, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Fix with the test run named",
      expect: "stop: the fix is done and the message names the test run that shows it.",
      state: {
        request: "The date picker shows the wrong month in time zones west of UTC. Fix it.",
        last_reply:
          "Fixed. The picker built the month from a UTC date, so it slipped a day back west of UTC. It now uses the local date parts in src/datepicker/month.ts. I added a test for America/Los_Angeles and ran pnpm test src/datepicker: 14 passed, 0 failed.",
      },
    },
    {
      name: "Claims success without a check",
      expect: "continue: it says the bug is fixed but ran nothing to show it.",
      state: {
        request: "The CSV export drops the last row. Fix it and make sure the export tests pass.",
        last_reply:
          "I found the off-by-one in exportRows: the loop stopped at length - 1. I changed it to loop over every row. This should fix the missing last row and the export tests should pass now.",
      },
    },
    {
      name: "Blocked on a credential",
      expect: "stop: the agent needs a key only the user can provide.",
      state: {
        request: "Record the payment provider fixtures and commit them.",
        last_reply:
          "The recorder is ready, but it needs PAYMENTS_API_KEY in the environment and it is not set here. Can you export it in your shell and tell me when it is there? I will record and commit the fixtures after that.",
      },
    },
  ],
  borderline: {
    turn_outcome: {
      why: "Most of the request is done and the agent asks whether to do the last part, which the request already covered.",
      state: {
        request: "Rename the userId column to accountId everywhere: the schema, the migration, the queries and the tests.",
        last_reply:
          "I renamed the column in the schema and wrote the migration, and updated the queries in src/db. The tests still use userId in about 30 places. Do you want me to update the tests too?",
      },
    },
  },
});
