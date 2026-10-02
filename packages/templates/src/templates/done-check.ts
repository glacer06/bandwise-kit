import { defineTemplate } from "../types.js";

export const doneCheck = defineTemplate({
  id: "done-check",
  title: "Done check",
  job: "Decide whether a coding agent has really finished the request before it stops, or has work left, an unchecked claim or work nobody asked for.",
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
    "`overreach` means the message reports work well outside the request, such as a new feature, a refactor, or files and docs nobody asked for. It has no route of its own, so it is logged and reported and never sends the agent back. A false alarm costs nothing, and the count shows how often the agent strays.",
    "Send the agent back only when `route` is `continue` and `overallAction` is `auto`. Any other result lets it stop, so a doubtful gate never keeps an agent looping.",
    "Start in `shadow`: the gate runs and logs what it would have done, and the agent always stops as it would without the hook. Move it to `controlled` after reading a week of results; there only a high band answer sends the agent back.",
    "`unverified` and `overreach` have a stricter bar through `perOption`. They are the answers most likely to be false alarms: sending an agent back to rerun checks it already ran wastes a turn, and small tidying next to a fix is easy to over-call.",
    "A message that names a check it could not run, and why, is honest and counts as `finished`. Only a success claim with no check and no reason is `unverified`.",
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
                "Everything the request asked for is done, and any claim that code works is backed by a test, build or command the message says it ran. Also pick this when the request needed no check, such as a question answered, an explanation or a plan the user asked for, or when the message names the check it could not run here and why.",
              unverified:
                "The message says the change is done or fixed, but the claim rests on expectation, such as \"this should work now\", with no test, build or command it ran to show it and no reason given for skipping one.",
              work_left:
                "Parts of the request are still undone: the message lists next steps it has not taken, leaves TODOs, covers only some of the items asked for, or stops after a plan when the request asked for the change itself.",
              overreach:
                "The requested work is done, but the message also reports sizable work nobody asked for: a new feature, a refactor of code the request did not touch, new files, docs or tests beyond the change, or another review round. Small edits the change needed, such as renaming a helper it had to modify, do not count.",
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
        perOption: { unverified: { high: 0.8, medium: 0.5 }, overreach: { high: 0.8, medium: 0.5 } },
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
      name: "Fix plus an unrequested refactor",
      expect: "overreach: the bug is fixed and tested, but it also rewrote a module and added docs nobody asked for. Logged only; the agent stops.",
      state: {
        request: "The login form lets you submit with an empty password. Block that and show an error.",
        last_reply:
          "Done. The form now blocks an empty password and shows \"Enter your password\". I ran pnpm test src/auth: 22 passed. While I was there I moved all the form validation into a new src/forms/validators.ts module, switched the signup and reset forms over to it, and wrote docs/forms.md explaining the new pattern.",
      },
    },
  ],
  borderline: {
    turn_outcome: {
      why: "A tested fix that also renamed a helper it had to change to make the fix clear: finished, or small overreach.",
      state: {
        request: "formatPrice shows $1,00 instead of $1.00 for German users on the English site. Fix it.",
        last_reply:
          "Fixed. formatPrice took the locale from the browser instead of the site, so I pass the site locale in. The helper it called was named getLocale, which hid that, so I renamed it to getSiteLocale in the two files that use it. pnpm test src/pricing: 9 passed, including a new de-DE browser case.",
      },
    },
  },
});
