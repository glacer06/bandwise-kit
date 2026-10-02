# Bandwise kit

Bandwise turns the yes/no, pick-one and score decisions your app sends to an LLM today into small, typed question sets that run on a System One model such as Jev. Each answer comes back with a confidence band and an action, so your code knows when to act on its own and when to ask a person.

Bandwise is an independent product built on TypeSafe's System One models.

This repository is the free, open part of Bandwise, under the Apache License 2.0:

- the question set spec format and the run engine (`@bandwise/core`)
- the `bandwise` command with a local mode that runs a spec on a state with no network and no key (`@bandwise/cli`)
- the transports that call a System One model with your own key, or answer from fixtures (`@bandwise/system-one-client`)
- a template pack of ready specs with example states (`@bandwise/templates`)
- a Claude Code skill, find-decisions, that finds LLM calls in your code that are really decisions and drafts a spec for each

## Quickstart

You need Node 22 or later.

```sh
git clone https://github.com/glacer06/bandwise-kit.git
cd bandwise-kit
npx @bandwise/cli run --local examples/email-triage.spec.json examples/email-triage.state.json
```

To work on the kit itself, build from source instead:

```sh
pnpm install && pnpm -r build
node packages/cli/dist/bin.js run --local examples/email-triage.spec.json examples/email-triage.state.json
```

The output lists every decision with its value, band and action, the overall action, the route, and what the run would cost. Add `--json` to get the full result envelope instead.

Local mode makes no network call and needs no key. It answers from recorded fixtures when one matches the request and from synthetic answers otherwise, and it says which. Synthetic answers are not model output: local mode proves that a spec and a state are valid and shows how the bands and actions play out. It does not tell you whether the answers are right.

Try any template the same way:

```sh
npx @bandwise/cli run --local \
  plugins/claude-code/skills/find-decisions/templates/pr-safety-gate.spec.json \
  plugins/claude-code/skills/find-decisions/templates/pr-safety-gate.state.json
```

Other options: `--provider typesafe|openrouter|vercel`, `--rollout shadow|controlled|full|paused` and `--channel production|staging`. Run `npx @bandwise/cli --help` for the full usage.

## Run live with your own key

`--live` runs the same spec against the real model. The key comes only from your environment: `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY` with `--provider openrouter` or `--provider vercel`. The CLI never reads a key from a flag, a spec or a file, never prints it, and sends it only to the provider's own API.

```sh
export TYPESAFE_API_KEY=...   # your own key
npx @bandwise/cli run --live examples/email-triage.spec.json examples/email-triage.state.json --receipts
npx @bandwise/cli report --since 7d
```

`--receipts` appends one line per run to `~/.bandwise/receipts.jsonl`: the set, the spec hash, each decision's value, band and action, the System One cost, the counterfactual LLM cost and the latency. Never the state. `bandwise report` sums them per set. Savings are estimates: the counterfactual prices one comparator LLM call per decision.

## Claude Code hooks

The agent pack runs as Claude Code hooks: `done-check` on `Stop`, `action-risk-gate` on `PreToolUse` and `model-tier` on `UserPromptSubmit`. The specs and example states are in `.bandwise/`.

```sh
npx @bandwise/cli hooks install --sets-dir .bandwise/sets --command "npx @bandwise/cli"
```

That prints the entries for `.claude/settings.json` and writes nothing. Every entry starts with `--rollout shadow`: the hook runs, writes a receipt and never blocks, denies or adds context. Change one entry to `--rollout controlled` after reading its receipts, and only a high band answer acts. A hook sends only the fields the set's input schema names, with secret-shaped text redacted. Any error, a missing key or a 3 second timeout ends the hook with exit 0 and no output, so it never breaks a session.

## Launch profiles

`bandwise launch -- <claude args>` picks a launch profile for a new Claude Code session from `.bandwise/profiles.json`, an allowlist of models and effort levels you review like code, and starts `claude` with that profile's `--model` and `--effort`. Your own arguments pass through unchanged and permission flags are never touched. `--print` prints the pick as JSON and starts nothing. In `shadow` the default is always used and the receipt records the pick. Any error, a missing key or a 3 second timeout uses the default, so a launch is never blocked.

## How a question set works

A question set is one JSON spec. It names the model, describes the input state with a JSON Schema, asks questions in one or more stages, and sets a policy for every question. Later stages can read earlier answers. Routes turn the answers into one output your app branches on, such as `urgent` or `read_later`.

### Three answer types

| Type | Asks | Answer |
|---|---|---|
| `noul` | Does this hold? Yes or no. | The probability of yes, from 0 to 1. |
| `choice` | Which one of these options? | The chosen option with a probability for every option. Give every choice a "none of these" option. |
| `score` | How much, on a fixed rubric? | A probability-weighted level on an ordered rubric you write. |

Exact rules such as a sender domain, a length or a date comparison do not belong in a question. Put them in the spec's `checks` or keep them in code.

### Bands and actions

Every answer lands in a band: `high`, `medium` or `low`. The policy sets the thresholds. For a noul, `trueAt` and `falseAt` mark a confident yes or no, and `reviewMargin` widens them into the medium band. A noul near 0.5 means yes and no are about equally likely, so it lands in the low band with no value. For a choice or a score, the thresholds apply to the answer's confidence.

Each band maps to an action:

| Action | What your app does |
|---|---|
| `auto` | Act on the answer. |
| `review` | Hold the decision for a person. |
| `fallback` | Do what the policy's fallback says: use a fixed value, run another set, or do nothing. |
| `escalate_to_llm` | Send this case to the LLM you use today. |

Gating questions decide the run's overall action. The rollout stage limits what may act. In `full` every decision takes its policy action. In `controlled` only the high band acts, and other gating decisions go to `review`. In `shadow` and `paused` nothing acts and every decision comes back as `fallback`. If the model is unavailable, the spec's `onUnavailable` rule applies instead, and it defaults to `review`.

Confidence is the spread of the model's answer, not the chance of being right. Treat the template thresholds as starting points and tune them on 20 to 50 labeled examples from your own data.

## Templates

The template pack (`@bandwise/templates`) ships 13 specs. Each has two or three example states and one borderline case per question. The same specs, with one example state each, sit in `plugins/claude-code/skills/find-decisions/templates/`.

| Template | What it decides | Questions |
|---|---|---|
| `email-triage` | Decide whether an email needs the recipient soon, and what kind of message it is. | `real_person`, `someone_waiting`, `cost_of_ignoring`, `category`, `work_type` |
| `pr-safety-gate` | Decide whether a pull request is safe to merge without a human reviewer. | `touches_sensitive_code`, `tests_weakened`, `risky_migration`, `mixed_concerns` |
| `log-line-pager` | Decide whether one log line needs a human now, so only real problems page someone. | `needs_human_now` |
| `context-pruner` | Decide, item by item, whether an agent's context item still matters for the current task, and drop the rest unchanged. | `still_matters` |
| `wake-gate` | Decide whether an event should wake a sleeping agent now, later, or not at all. | `wake_decision` |
| `done-check` | Decide whether a coding agent has really finished the request before it stops, or has work left, an unchecked claim or work nobody asked for. | `turn_outcome` |
| `action-risk-gate` | Decide whether a coding agent's shell command or file edit is risky enough that a person should confirm it before it runs. | `risky_command`, `risky_file_change`, `risk_kind` |
| `model-tier` | Decide how hard a new request to a coding agent is, so mechanical work can go to a cheaper model or subagent. | `difficulty`, `high_stakes` |
| `launch-profile` | Pick a launch profile for a coding agent session before it starts, from a list the host has approved. | `profile` |
| `security-finding-triage` | Decide whether a static analysis finding is reachable from user input, and how bad it is in context. | `reachable_from_user_input`, `severity_in_context` |
| `error-triage` | Decide which team owns a new error tracker issue, how much it hurts users, and whether the latest release caused it. | `owning_team`, `user_impact`, `new_regression` |
| `lead-event-scoring` | Score how ready an account is to buy from its recent product events, and pick the next sales action. | `buying_intent`, `next_action` |
| `inbound-email-routing` | Send each email that reaches a shared address to the right queue, and flag the ones that need a human reply today. | `queue`, `needs_reply_today` |

```ts
import { TEMPLATES, getTemplate } from "@bandwise/templates";

const triage = getTemplate("email-triage");
console.log(triage?.spec.stages[0]?.questions);
```

The templates are checked to run. They are not measured for accuracy.

## The find-decisions skill for Claude Code

find-decisions scans a repository for LLM calls whose output is used as a decision: compared to fixed strings, parsed as yes or no, compared to a cutoff, or used to pick from a list. It classifies each one as noul, choice or score, flags poor fits, ranks the rest, drafts a spec from the closest template for the top candidates, validates each draft with `bandwise run --local` when the CLI is installed, and writes a short report to `bandwise/find-decisions-report.md`. It runs on your machine and never sends code anywhere.

Install it into a project:

```sh
mkdir -p .claude/skills
cp -R /path/to/bandwise-kit/plugins/claude-code/skills/find-decisions .claude/skills/
```

Or into your user folder to use it in every project: copy the same folder to `~/.claude/skills/`. Then ask Claude Code to "find decisions in this repo".

## Calling a model with your own key

`@bandwise/core` runs a spec through ports you provide, and `@bandwise/system-one-client` provides the transport. `SdkTransport` calls TypeSafe directly, or OpenRouter or the Vercel AI Gateway, with a key you hold. Keep that key on your server. Never put it in a browser bundle or paste it into a chat tool.

## Bandwise Cloud

The kit runs one spec at a time on your machine. Bandwise Cloud is the optional hosted product around it: versioned sets with rollout and rollback, a review queue for decisions held for a person, a savings ledger that records what every run cost against the LLM it replaced, and calibration of thresholds on your own labels. Nothing in the kit needs it. See https://www.bandwise.dev.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm bandwise run --local examples/email-triage.spec.json examples/email-triage.state.json
```

See `CONTRIBUTING.md`. Report security problems privately, as `SECURITY.md` describes.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
