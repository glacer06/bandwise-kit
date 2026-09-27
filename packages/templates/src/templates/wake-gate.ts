import { defineTemplate } from "../types.js";

const agent = {
  goal: "Ship the v2 billing export once finance approves the column list.",
  waiting_for: "Finance approval of the export columns, from anyone on the finance team.",
};

export const wakeGate = defineTemplate({
  id: "wake-gate",
  title: "Wake gate",
  job: "Decide whether an event should wake a sleeping agent now, later, or not at all.",
  pattern: "intent_routing",
  whenToUse: [
    "A long-running agent sleeps until something relevant happens, and waking it on every event costs a full LLM turn.",
    "Events arrive from chat, email, tickets or webhooks, and most of them have nothing to do with what the agent waits for.",
  ],
  whenNotToUse: [
    "The agent waits for one exact signal, such as a webhook with a known id or a status field changing. Match it in code.",
    "Deciding needs the agent's full history and planning. Wake the agent and let it decide.",
  ],
  notes: [
    "Routes: `wake` wakes the agent now, `sleep` keeps it asleep (the event is related but not the trigger yet), `ignore` drops the event. `unclear` and every non-auto action wake the agent, so the gate never hides an event it is unsure about.",
    "Outage rule: `onUnavailable` is `review`. During a System One outage every event comes back as `review`. Treat that as wake, with a note that the gate was unavailable, or put the event in a queue a person reads. Never drop events during an outage.",
    "Skip limit: count consecutive `sleep` and `ignore` decisions per agent in your code, and wake the agent anyway after a limit (for example 50 events or 6 hours, whichever comes first). Counting stays in code, since models are weak at it, and the limit makes sure a wrong gate cannot keep an agent asleep forever.",
    "Keep `agent.goal` and `agent.waiting_for` short and specific. The gate is only as good as that description.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["agent", "event"],
        properties: {
          agent: {
            type: "object",
            required: ["goal", "waiting_for"],
            properties: {
              goal: { type: "string", maxLength: 1000 },
              waiting_for: { type: "string", maxLength: 1000 },
            },
          },
          event: {
            type: "object",
            required: ["source", "content"],
            properties: {
              source: { type: "string" },
              from: { type: "string" },
              content: { type: "string", maxLength: 8000 },
            },
          },
        },
      },
    },
    stages: [
      {
        id: "gate",
        questions: {
          wake_decision: {
            type: "choice",
            instructions: {
              question:
                "An agent is asleep and waiting for something specific. Given this new event, what should happen to the agent?",
              agent_goal: "`agent.goal`",
              agent_waiting_for: "`agent.waiting_for`",
              new_event: "`event`",
            },
            criteria: {
              wake: "The event is what the agent waits for, or it changes the agent's goal, so the agent should act now.",
              not_yet: "The event is about the agent's goal but is not the thing it waits for yet, such as progress or a partial answer.",
              unrelated: "The event has nothing to do with the agent's goal.",
              unclear: "The event could matter, but it does not give enough to tell.",
            },
            meta: { label: "Wake the agent" },
          },
        },
      },
    ],
    policies: {
      wake_decision: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.7, medium: 0.4 },
        actions: {
          high: { kind: "auto" },
          medium: { kind: "review" },
          low: { kind: "fallback", config: { kind: "value", value: "wake" } },
        },
      },
    },
    routes: [
      { when: { q: "wake_decision", eq: "wake" }, output: "wake" },
      { when: { q: "wake_decision", eq: "not_yet" }, output: "sleep" },
      { when: { q: "wake_decision", eq: "unrelated" }, output: "ignore" },
    ],
    defaultRoute: "wake",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 30, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "The approval arrives",
      expect: "wake: this is what the agent waits for.",
      state: {
        agent,
        event: {
          source: "chat",
          from: "priya (finance)",
          content: "Columns look good to me, approved. Go ahead with the export.",
        },
      },
    },
    {
      name: "Progress, not the answer",
      expect: "sleep: related, but approval has not happened.",
      state: {
        agent,
        event: { source: "chat", from: "priya (finance)", content: "Looking at the export columns this afternoon." },
      },
    },
    {
      name: "Unrelated message",
      expect: "ignore: nothing to do with the export.",
      state: {
        agent,
        event: { source: "email", from: "it-helpdesk", content: "Reminder: laptops need the OS update by Friday." },
      },
    },
  ],
  borderline: {
    wake_decision: {
      why: "A conditional approval: it approves most columns but asks for one change.",
      state: {
        agent,
        event: {
          source: "chat",
          from: "priya (finance)",
          content: "Approved except the tax_region column, please rename it to region. Otherwise fine.",
        },
      },
    },
  },
});
