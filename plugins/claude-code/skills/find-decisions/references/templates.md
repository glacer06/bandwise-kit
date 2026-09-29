# Template index

Generated from the template pack. Do not edit by hand.

Start a draft from the closest template: copy its spec, rename the state fields to match the code, rewrite the instructions and options for the real decision, and keep the policy shape unless the risk differs.

## email-triage

Email triage. Decide whether an email needs the recipient soon, and what kind of message it is.

- Pattern: `composite_scoring`
- Questions: `real_person` (noul), `someone_waiting` (noul), `cost_of_ignoring` (score), `category` (choice), `work_type` (choice)
- State: `email`, `me`
- Routes: `urgent`, `read_later`, `normal`
- Use when: An inbox or shared mailbox where people lose time sorting mail by hand. You already ask an LLM "is this urgent?" and act on a yes or no. Urgency means a person wrote it, someone is waiting, and ignoring it costs something.
- Not when: You need a reply drafted. That is text generation; keep an LLM for it and use this set to decide which mail gets one. The rule is exact, such as a sender domain or a subject tag. Keep that in code or in a spec check.
- Files: `templates/email-triage.spec.json`, `templates/email-triage.state.json`

## pr-safety-gate

PR safety gate. Decide whether a pull request is safe to merge without a human reviewer.

- Pattern: `composite_scoring`
- Questions: `touches_sensitive_code` (noul), `tests_weakened` (noul), `risky_migration` (noul), `mixed_concerns` (noul)
- State: `pr`
- Routes: `needs_human`, `auto_merge`
- Use when: Bots or agents open many small pull requests (dependency bumps, generated fixes, copy changes) and you want the safe ones merged without waiting. Your team can name the risks that always need a person: sensitive code, weakened tests, destructive migrations, changes that mix several concerns.
- Not when: You want a code review with comments. That is text generation; keep an LLM or a person for it. Your branch protection already requires a human review on every pull request. Change that policy first. The only rule is size. Diff size is a number, so compare it in code (this template does that in a check).
- Files: `templates/pr-safety-gate.spec.json`, `templates/pr-safety-gate.state.json`

## log-line-pager

Log-line pager. Decide whether one log line needs a human now, so only real problems page someone.

- Pattern: `confidence_routing`
- Questions: `needs_human_now` (noul)
- State: `log`, `service`, `recent_lines`
- Routes: `page`, `log_only`
- Use when: Alerting on error logs pages people for noise, and regex rules keep growing. A person on call can tell in a few seconds whether a line matters.
- Not when: You need a root cause or a summary of an incident. That takes longer than 10 seconds and is text generation. The rule is a threshold on a metric, such as error rate above 5 percent. Keep that in your metrics system. Volume is so high that a model call per line is too slow or costly. Sample or group lines in code first.
- Files: `templates/log-line-pager.spec.json`, `templates/log-line-pager.state.json`

## context-pruner

Context pruner. Decide, item by item, whether an agent's context item still matters for the current task, and drop the rest unchanged.

- Pattern: `confidence_routing`
- Questions: `still_matters` (noul)
- State: `task`, `item`
- Routes: `drop`, `keep`
- Use when: An agent's context fills with old tool calls, tool results and messages, and you pay for every token on every step. You want to keep or drop whole items. Nothing gets reworded, so nothing gets distorted.
- Not when: You want a summary of the dropped items. That is text generation; keep an LLM for it. Items are tiny and few. The saving will not cover the call. The rule is mechanical, such as dropping tool results older than a set number of steps. Keep that in code.
- Files: `templates/context-pruner.spec.json`, `templates/context-pruner.state.json`

## wake-gate

Wake gate. Decide whether an event should wake a sleeping agent now, later, or not at all.

- Pattern: `intent_routing`
- Questions: `wake_decision` (choice)
- State: `agent`, `event`
- Routes: `wake`, `sleep`, `ignore`
- Use when: A long-running agent sleeps until something relevant happens, and waking it on every event costs a full LLM turn. Events arrive from chat, email, tickets or webhooks, and most of them have nothing to do with what the agent waits for.
- Not when: The agent waits for one exact signal, such as a webhook with a known id or a status field changing. Match it in code. Deciding needs the agent's full history and planning. Wake the agent and let it decide.
- Files: `templates/wake-gate.spec.json`, `templates/wake-gate.state.json`

## done-check

Done check. Decide whether a coding agent has really finished the request before it stops, or has work left or an unchecked claim.

- Pattern: `confidence_routing`
- Questions: `turn_outcome` (choice)
- State: `request`, `last_reply`
- Routes: `continue`, `stop`
- Use when: A coding agent such as Claude Code stops early: it leaves steps undone, stops after a plan, or says a fix works without running anything. You can hook the moment the agent stops (the Claude Code `Stop` hook) and hand it the request and its final message.
- Not when: You need to know whether the code is correct. That takes tests and a review, not a 10 second read of the final message. The task has an exact finish line code can check, such as a test command exiting 0. Check it in code. The agent runs unattended with no way to send it back to work. There is nothing to act on.
- Files: `templates/done-check.spec.json`, `templates/done-check.state.json`

## action-risk-gate

Action risk gate. Decide whether a coding agent's shell command or file edit is risky enough that a person should confirm it before it runs.

- Pattern: `fan_out`
- Questions: `risky_command` (noul), `risky_file_change` (noul), `risk_kind` (choice)
- State: `tool`, `command`, `file_path`, `content_preview`, `description`
- Routes: `ask`, `allow`
- Use when: A coding agent such as Claude Code runs shell commands and edits files with broad permissions, and a few of its actions (deleting data, force pushing, publishing, touching secrets or CI) should wait for a person. Allow and deny lists keep missing cases, because the same command can be routine in one form and destructive in another.
- Not when: The rule is exact, such as never running `git push --force` or never writing outside the repo. Put it in the agent's permission rules, which are certain and free. You want to know whether the change is correct. That is a code review, not a 10 second risk call. Every action already waits for a person. The gate would add cost and nothing else.
- Files: `templates/action-risk-gate.spec.json`, `templates/action-risk-gate.state.json`

## model-tier

Model tier. Decide how hard a new request to a coding agent is, so mechanical work can go to a cheaper model or subagent.

- Pattern: `intent_routing`
- Questions: `difficulty` (score), `high_stakes` (noul)
- State: `prompt`
- Routes: `hard`, `mechanical`, `standard`
- Use when: A coding agent runs every request on its largest model, and many requests are mechanical: renames, formatting, moving files, running a command, finding where something lives. The agent can hand work to a subagent or a cheaper model, and you want advice on when to do it before the first turn starts.
- Not when: The agent cannot pick a model per task. Advice it cannot act on only adds tokens. You need a plan or an estimate for the task. That is text generation and takes longer than 10 seconds. The request names the model or the tier itself. Read it in code.
- Files: `templates/model-tier.spec.json`, `templates/model-tier.state.json`

## security-finding-triage

Security finding triage. Decide whether a static analysis finding is reachable from user input, and how bad it is in context.

- Pattern: `confidence_routing`
- Questions: `reachable_from_user_input` (noul), `severity_in_context` (score)
- State: `finding`
- Routes: `auto_close`, `review`
- Use when: A code scanner reports more findings than your team can read, and most are false positives in practice. A reviewer can tell from the finding, the code around it and where its input comes from whether it matters.
- Not when: You need a fix written. That is text generation; keep an LLM or a person for it. Deciding reachability needs a whole-program trace across many files. Run a taint analysis tool, then use this set on its output. The rule is exact, such as closing every finding in test files. Do that in code before the call.
- Files: `templates/security-finding-triage.spec.json`, `templates/security-finding-triage.state.json`

## error-triage

Error triage. Decide which team owns a new error tracker issue, how much it hurts users, and whether the latest release caused it.

- Pattern: `fan_out`
- Questions: `owning_team` (choice), `user_impact` (score), `new_regression` (noul)
- State: `issue`, `release`
- Routes: `page`, `regression`, `backlog`
- Use when: New issues from your error tracker sit unassigned because nobody knows whose they are. An engineer can tell the owner and the impact from the title, stack trace and release notes in a few seconds.
- Not when: You need a root cause analysis or a fix. That takes longer than 10 seconds and is text generation. Ownership follows file paths exactly, such as a CODEOWNERS file. Look it up in code. The impact is a number you already have, such as affected users per hour. Threshold it in code.
- Files: `templates/error-triage.spec.json`, `templates/error-triage.state.json`

## lead-event-scoring

Lead and event scoring. Score how ready an account is to buy from its recent product events, and pick the next sales action.

- Pattern: `confidence_routing`
- Questions: `buying_intent` (score), `next_action` (choice)
- State: `account`, `events`
- Routes: `sales_call`, `send_docs`, `nurture_email`, `no_action`
- Use when: Product analytics shows what trial or free accounts do, and sales wants to know who to call. A salesperson can read an account's recent events and say "call them" or "not yet" in a few seconds.
- Not when: You need a personalized outreach email. That is text generation; use this set to decide who gets one. Your scoring rule is arithmetic, such as points per event with a cutoff. Keep it in code. You want to count events or compare dates. Do that in code and pass the results in the state.
- Files: `templates/lead-event-scoring.spec.json`, `templates/lead-event-scoring.state.json`

## inbound-email-routing

Inbound email routing. Send each email that reaches a shared address to the right queue, and flag the ones that need a human reply today.

- Pattern: `intent_routing`
- Questions: `queue` (choice), `needs_reply_today` (noul)
- State: `email`
- Routes: `support`, `billing`, `sales`, `partnerships`, `security`, `archive`, `triage_by_hand`
- Use when: A shared address such as hello@ or support@ gets mail for several teams, and someone forwards it by hand. You parse inbound mail with a webhook and want a queue name back, not a paragraph. Pair it with the email triage template when a person's own inbox also needs urgency.
- Not when: You need the reply written. That is text generation; route first, then let an LLM or a person reply. Routing follows the address exactly, such as billing@ always going to billing. Do that in code.
- Files: `templates/inbound-email-routing.spec.json`, `templates/inbound-email-routing.state.json`
