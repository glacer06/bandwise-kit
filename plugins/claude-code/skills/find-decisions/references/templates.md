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
