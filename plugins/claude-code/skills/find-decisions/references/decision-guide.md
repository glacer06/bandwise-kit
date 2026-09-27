# Decision guide: Noul, Choice or Score

## Fit test first

Would a person need more than about 10 seconds to make this call?

- **Under 10 seconds** (is this from a real person, which team owns this, is this line worth a page): a good fit.
- **Over 10 seconds** (write a reply, weigh a contract, plan a change): keep the LLM. A System One gate in front of it can still decide when the LLM is needed (`cascade`).

## Poor fits

Flag the candidate and write no draft when:

- **It must generate text.** Summaries, replies, code, translations, extracted names or amounts. The model picks from options; it does not write.
- **It needs more than 10 seconds of judgment.** Multi-step reasoning, reading long documents end to end, weighing many trade-offs.
- **The options are unbounded.** "Which product does the user mean" across a live catalog of thousands. A Choice needs a fixed list (at most a few dozen options). If code can narrow the list to a few candidates first, it becomes a fit.
- **It is an exact rule.** Arithmetic, counting, date comparison, lookups, regex on a known format. That is `keep_in_code`.

## Pick the primitive

| The question is | Primitive | Output | Example |
|---|---|---|---|
| Does X hold? | **Noul** | true or false with a probability | Is this email from a real person? Does this PR touch auth? |
| Which one of these? | **Choice** | one option key from a fixed list | Which queue? Which team? Wake, not yet or unrelated? |
| How much, on a fixed scale? | **Score** | a level from 2 to 10 ordered levels | How severe? How ready to buy? |

- A prompt that asks for "yes/no" is a Noul. Word the true criterion positively ("A person wrote this"), not as a negation.
- A prompt that returns one label from a list is a Choice. Always add a "none of these" option.
- A prompt that returns a 1 to 5 rating is a Score. Describe every level in words.
- A prompt that returns several labels or a JSON object with several fields is several questions, one per field, asked in one stage.
- "Keep or drop" per item is a Noul per item ("does this still matter"). Do not ask the model to choose a subset of a list.

## Pick the pattern

| Pattern | Use when | Spec shape |
|---|---|---|
| `confidence_routing` | One judgment where acting on a wrong answer is costly | One gating question: high band `auto`, medium `review`, low `review` or `fallback` |
| `intent_routing` | Requests go to different handlers | A Choice with a "none" option and `routes` per option |
| `composite_scoring` | A complex judgment that splits into weighted checks | Several Noul or Score questions and a weighted `composites` entry |
| `fan_out` | Several independent judgments about one input, some only relevant sometimes | One stage with every question; speculative ones get `relevantWhen` |
| `cascade` | An LLM does the job today and most cases are easy | Low band `escalate_to_llm` |
| `top_choice` | Only the best option matters and a wrong pick is cheap | A non-gating Choice, every band `auto` |
| `keep_in_code` | Arithmetic, dates, exact rules, lookups | No question; a spec `check` or plain code |

## Map to a template

| The code decides | Start from |
|---|---|
| Urgency or category of personal or team mail | `email-triage` |
| Which queue a shared inbox message goes to | `inbound-email-routing` |
| Whether a change can merge without review | `pr-safety-gate` |
| Whether a log line or alert needs a person now | `log-line-pager` |
| Which context items an agent keeps | `context-pruner` |
| Whether an event wakes a waiting agent | `wake-gate` |
| Whether a scanner finding is real | `security-finding-triage` |
| Owner, impact or cause of an error | `error-triage` |
| Buying intent or next action from product events | `lead-event-scoring` |

When nothing is close, start from the template with the same pattern and replace its questions.
