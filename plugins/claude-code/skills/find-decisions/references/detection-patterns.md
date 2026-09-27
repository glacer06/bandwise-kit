# Detection patterns

Search patterns for LLM calls, then the signals that a call is a decision. Use them with ripgrep or the Grep tool. They are starting points: always read the code around a hit.

## LLM calls

| Library | Language | Search for |
|---|---|---|
| Anthropic SDK | TS/JS | `@anthropic-ai/sdk`, `messages.create(`, `messages.stream(` |
| Anthropic SDK | Python | `import anthropic`, `from anthropic`, `.messages.create(` |
| OpenAI SDK | TS/JS | `from "openai"`, `chat.completions.create(`, `responses.create(`, `.beta.chat.completions.parse(` |
| OpenAI SDK | Python | `import openai`, `from openai`, `chat.completions.create(`, `responses.create(`, `.parse(` |
| Vercel AI SDK | TS/JS | `from "ai"`, `generateText(`, `generateObject(`, `streamText(`, `streamObject(` |
| LangChain | TS/JS | `@langchain/`, `ChatOpenAI`, `ChatAnthropic`, `.invoke(`, `withStructuredOutput(` |
| LangChain | Python | `langchain`, `ChatOpenAI`, `ChatAnthropic`, `.invoke(`, `with_structured_output(` |
| LiteLLM | Python | `import litellm`, `litellm.completion(`, `acompletion(` |
| Raw HTTP | any | `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `api.openai.com`, `api.anthropic.com`, `openrouter.ai/api` |
| Other providers | any | `generativelanguage.googleapis.com`, `bedrock-runtime`, `api.mistral.ai`, `api.groq.com`, `ollama` |

Also search for the repo's own wrappers (`askLLM`, `classify`, `judge`, `llm(`) once you see one, and find every caller.

## Existing System One calls

A repo may already call Jev directly. These are the easiest candidates: the questions exist, so the draft spec is a translation, and the win is versions, bands, review and a cost record rather than a model swap. Report them in their own group, and check whether the code applies a threshold and what it does on an error.

| Library | Language | Search for |
|---|---|---|
| TypeSafe SDK | TS/JS | `@typesafe-ai/sdk`, `TypeSafeClient`, `.systemOne(` |
| TypeSafe SDK | Python | `typesafe`, `TypeSafeClient`, `.system_one(` |
| Vercel AI SDK | TS/JS | `experimental_evaluate`, `typesafe-ai/jev` |
| Raw HTTP | any | `/v1/systemone`, `api.typesafe.ai`, `ai-gateway.vercel.sh/typesafe`, `openrouter.ai/api/v1/systemone`, `/typesafe/v1/systemone` (a LiteLLM proxy) |
| Cloudflare Workers AI | TS/JS | `typesafe/jev` with `env.AI.run(` or `/ai/run` |

## Decision signals in the prompt

- "classify", "categorize", "label", "which category", "which of the following"
- "answer yes or no", "true or false", "respond with only", "one word"
- "is this relevant", "is this spam", "does this", "should we"
- "rate from 1 to", "score from", "on a scale of", "how likely", "priority"
- "pick the best", "choose one of", "select the", "route to"
- "keep or drop", "filter out", "which items still matter"
- a JSON schema or tool definition with an `enum`, a `boolean` or a small `integer` range

## Decision signals in how the output is used

- `===`, `==`, `in`, `includes` against fixed strings; `switch` or `match` on the output
- `.toLowerCase().startsWith("yes")`, `== "true"`, `parseInt(...) >= 3`, `float(...) > 0.5`
- `JSON.parse(...)` or a structured output parser whose schema is an enum, boolean or number
- the output indexes a map of handlers, queues, models or teams
- `filter`, `sort` or `slice` driven by the output
- `if` branches, early returns, retries or escalations driven by the output

## Signs it is not a decision

- The output is shown to a user, saved as content, sent as an email, or passed to another prompt as text.
- The output is code, SQL, a summary, a translation or an extraction of free values (names, amounts, dates).
- The output feeds an agent loop that plans multiple steps.

## Volume and cost evidence

- Inside an HTTP handler, a webhook handler, a queue consumer or a stream processor: once per request or message.
- Inside `for`, `map`, `Promise.all` or `asyncio.gather`: once per item; note the batch size if the code sets one.
- A cron expression, a scheduler or a `setInterval`: note the schedule.
- The model id and `max_tokens` or `max_output_tokens`; a long system prompt or large interpolated context.
- Retries around the call multiply its cost.
