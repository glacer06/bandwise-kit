import { defineTemplate } from "../types.js";

export const inboundEmailRouting = defineTemplate({
  id: "inbound-email-routing",
  title: "Inbound email routing",
  job: "Send each email that reaches a shared address to the right queue, and flag the ones that need a human reply today.",
  pattern: "intent_routing",
  whenToUse: [
    "A shared address such as hello@ or support@ gets mail for several teams, and someone forwards it by hand.",
    "You parse inbound mail with a webhook and want a queue name back, not a paragraph.",
    "Pair it with the email triage template when a person's own inbox also needs urgency.",
  ],
  whenNotToUse: [
    "You need the reply written. That is text generation; route first, then let an LLM or a person reply.",
    "Routing follows the address exactly, such as billing@ always going to billing. Do that in code.",
  ],
  notes: [
    "Replace the `queue` options with your own queues, and keep `none_of_these`.",
    "Move the email only when `overallAction` is `auto`. `review` goes to a person who sorts by hand. The `route` is the queue name.",
    "`security_report` has a stricter bar through `perOption`, since a missed vulnerability report is costly.",
    "`needs_reply_today` only counts when the queue is not `spam_or_automated`.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["email"],
        properties: {
          email: {
            type: "object",
            required: ["from", "to", "subject", "text"],
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              subject: { type: "string" },
              text: { type: "string", maxLength: 20000 },
            },
          },
        },
      },
    },
    stages: [
      {
        id: "route",
        questions: {
          queue: {
            type: "choice",
            instructions:
              "Which team should handle `email`, judged by what the sender wants? It arrived at the shared address `email.to`.",
            criteria: {
              support: "A customer needs help using the product or reports something broken.",
              billing: "Invoices, refunds, payment failures, plan changes or cancellations.",
              sales: "A prospect asks about buying, pricing, a demo or a quote.",
              partnerships: "Integrations, resellers, co-marketing or vendor pitches.",
              security_report: "Someone reports a vulnerability or a security concern in the product.",
              spam_or_automated: "Spam, bulk mail, auto-replies, bounces or notifications.",
              none_of_these: null,
            },
            meta: { label: "Queue" },
          },
          needs_reply_today: {
            type: "noul",
            instructions:
              "If `email` is from a person who wants something, does that person need a human reply today to avoid real harm or a lost customer?",
            criteria: {
              true: "Delay would cost something today: an outage, a blocked customer, a payment problem, a deadline or an angry escalation.",
              false: "A reply within a few working days is fine.",
            },
            meta: { label: "Needs a human reply today" },
          },
        },
      },
    ],
    policies: {
      queue: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.6, medium: 0.35 },
        perOption: { security_report: { high: 0.8, medium: 0.5 } },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
      needs_reply_today: {
        type: "noul",
        gating: true,
        relevantWhen: { q: "queue", neq: "spam_or_automated" },
        noul: { trueAt: 0.75, falseAt: 0.25, reviewMargin: 0.1 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    },
    routes: [
      { when: { q: "queue", eq: "support" }, output: "support" },
      { when: { q: "queue", eq: "billing" }, output: "billing" },
      { when: { q: "queue", eq: "sales" }, output: "sales" },
      { when: { q: "queue", eq: "partnerships" }, output: "partnerships" },
      { when: { q: "queue", eq: "security_report" }, output: "security" },
      { when: { q: "queue", eq: "spam_or_automated" }, output: "archive" },
    ],
    defaultRoute: "triage_by_hand",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 60, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Failed payment",
      expect: "billing, needs a reply today.",
      state: {
        email: {
          from: "ops@customer.example.com",
          to: "hello@yourco.example",
          subject: "Card declined, account locked",
          text: "Our card was declined this morning and now the whole team is locked out. We updated the card but it still says suspended. Please help, we have a client demo at 3pm.",
        },
      },
    },
    {
      name: "Demo request",
      expect: "sales, no same-day reply needed.",
      state: {
        email: {
          from: "maria@prospect.example.org",
          to: "hello@yourco.example",
          subject: "Demo for a 40 person team?",
          text: "We are comparing tools for next quarter. Could we book a demo sometime in the next few weeks?",
        },
      },
    },
    {
      name: "Out of office reply",
      expect: "spam_or_automated, archived.",
      state: {
        email: {
          from: "noreply@partner.example.net",
          to: "hello@yourco.example",
          subject: "Automatic reply: Following up",
          text: "I am out of the office until Monday with limited access to email.",
        },
      },
    },
  ],
  borderline: {
    queue: {
      why: "A customer asks for a refund because a feature is broken: billing or support?",
      state: {
        email: {
          from: "kim@customer.example.com",
          to: "support@yourco.example",
          subject: "Refund please",
          text: "The export has not worked for two weeks and we cannot use the product. I would like a refund for this month.",
        },
      },
    },
    needs_reply_today: {
      why: "Polite follow-up on an old question, with a soft deadline later in the week.",
      state: {
        email: {
          from: "raj@customer.example.com",
          to: "hello@yourco.example",
          subject: "Following up on SSO",
          text: "Just checking in on my SSO question from last week. We present the rollout plan on Thursday.",
        },
      },
    },
  },
});
