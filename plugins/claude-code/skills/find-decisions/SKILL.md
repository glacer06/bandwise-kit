---
name: find-decisions
description: Use when someone wants to find LLM calls in a codebase that are really decisions (classification, yes/no gates, routing, picking from a list, scoring, relevance filters, keep or drop) and could run on a System One model such as Jev through a Bandwise question set. Scans the code locally, classifies each candidate as Noul, Choice or Score, flags poor fits, ranks them, drafts a Bandwise spec per top candidate from the closest template, validates drafts with `bandwise run --local` when the CLI is installed, and writes a short report. Never sends code anywhere.
---

# Find decisions

Many LLM calls do not need to write anything. They answer "yes or no", "which one" or "how much", and the app branches on the answer. Those calls can run on a System One model (Jev is the first) through a Bandwise question set, which is faster and cheaper, and returns a typed answer with a confidence that Bandwise maps to an action, instead of free text.

This skill finds those calls in the current repository and drafts a spec for the best ones. It is part of the free Bandwise kit.

## Privacy rules

- Everything happens on this machine. Read files, write files, run local commands. Nothing else.
- Never send source code, snippets, file contents, file paths or findings to any web search, web fetch, MCP tool, API or other service. That includes Bandwise, TypeSafe and any model provider.
- The only `bandwise` command this skill runs is `bandwise run --local`, which makes no network call.
- Example states you write are invented. Never copy customer data, secrets, keys or tokens from the code, fixtures or logs into a draft.

## Steps

### 1. Scope

Scan the repository root unless the person names a folder. Skip `node_modules`, `vendor`, `dist`, `build`, `.next`, `.venv`, `.git`, lock files and generated code. Tests and fixtures can confirm how a call is used, but a candidate must live in app code.

### 2. Find LLM calls

Search with the patterns in `references/detection-patterns.md`: SDK calls for Anthropic, OpenAI, the Vercel AI SDK, LangChain and LiteLLM, and raw `fetch` or HTTP calls to chat endpoints. Also follow wrappers: when the repo has its own `askLLM()` or `classify()` helper, find its callers. Search for direct System One calls too (`.systemOne(`, `.system_one(`, `experimental_evaluate`, `/v1/systemone`): list them as their own group, since their questions already exist and only need to move into a managed spec.

### 3. Keep only calls used as decisions

For each call, read the code around it and follow the output to where it is used. It is a decision when the output is:

- compared to fixed strings, parsed into an enum, or matched in a `switch`
- parsed as `true`/`false` or "yes"/"no" and used in a condition
- a number compared to a cutoff, or used to sort or rank
- an index or key into a fixed list (a route, a handler, a model, a queue)
- used to keep or drop items in a list

The prompt text helps too: "classify", "answer yes or no", "respond with one of", "rate from 1 to 5", "is this relevant", "which of the following". `references/detection-patterns.md` lists more signals.

### 4. Classify each candidate

Use `references/decision-guide.md`:

- **Primitive:** Noul ("does X hold"), Choice ("which one") or Score ("how much, on a fixed scale").
- **Pattern:** `fan_out`, `confidence_routing`, `composite_scoring`, `intent_routing`, `cascade`, `top_choice` or `keep_in_code`.
- **State:** the fields the decision needs, taken from what the prompt interpolates. Note anything large the prompt sends that the decision does not need.
- **Fit:** the 10-second test, and the poor-fit flags: the call must generate text, the decision needs more than about 10 seconds of human judgment, or the options are unbounded. A poor fit stays in the report with the reason, and gets no draft.
- **Volume and cost:** only what the code makes visible. A call inside a request handler, a loop over a batch, a queue consumer or a cron schedule; the model name; `max_tokens`. When the code does not show it, write "unknown". Never guess traffic numbers.

### 5. Rank

Order the good fits by:

1. How clear the decision is (a fixed option list in code beats a vague prompt).
2. Visible volume (a per-request or per-item call beats a one-off admin action).
3. Visible cost (a large model or long prompt beats a small one).
4. Risk of a wrong answer (lower risk first, since it can move to `auto` sooner).

### 6. Draft specs for the top candidates

Draft the top three unless the person asks for a different number. For each one:

1. Pick the closest template in `references/templates.md` and copy `templates/<id>.spec.json`.
2. Rename the state fields to match the data the code already has, and update `input.schema`.
3. Rewrite the instructions and options for the real decision. The question id is never sent to the model, so the instructions and option descriptions must carry the whole requirement. Refer to state with backticks, such as `` `ticket.body` ``.
4. Give every Choice a "none of these" option (`none_of_these`, `other` or `unclear`).
5. Move exact rules, arithmetic, counting and date comparison into `checks` or leave them in code.
6. Keep the template's model id if it is pinned, keep `onUnavailable: "review"`, and treat thresholds as starting points to tune on labeled examples.
7. Write the spec to `bandwise/sets/<slug>.json` and one invented example state to `bandwise/sets/<slug>.state.json`.

### 7. Validate

If the `bandwise` CLI is installed (`bandwise --help` works, or `npx --no-install bandwise --help` does), run:

```bash
bandwise run --local bandwise/sets/<slug>.json bandwise/sets/<slug>.state.json --json
```

Fix every lint error it reports, then run it again. Answers in local mode are synthetic unless a recorded fixture matches, so the run proves the spec and state are valid, not that the answers are right. If the CLI is not installed, say so in the report and do not install it without asking.

### 8. Write the report

Write `bandwise/find-decisions-report.md`, short and plain:

```markdown
# Decision candidates

## Summary
<one paragraph: calls found, decisions among them, drafts written>

## Candidates
| Rank | Location | Decision | Primitive | Pattern | Volume | Cost | Fit |
| 1 | src/triage.ts:40-72 | Route inbound mail to a queue | Choice | intent_routing | per email | model and max_tokens | good |

## Poor fits
<location, what it does, why it stays on an LLM or in code>

## Drafts
<per draft: spec path, template it started from, validation result>

## What to verify
<per draft: option list complete, state fields right, thresholds to tune on labeled examples, how app code should branch on overallAction and route>
```

Then tell the person where the report and drafts are, and that the next step is labeling 20 to 50 real examples per draft to tune thresholds.

## Rules

- Do not claim accuracy, savings or speed numbers. The report can say what is visible in code and what to measure.
- Do not edit app code. The drafts and the report are the only files this skill writes.
- One decision per question. If a prompt asks for several judgments at once, split them into several questions in one stage.
- If a call both decides and writes text (for example "classify and draft a reply"), the decision part can still be a candidate. Say which part stays on the LLM.
