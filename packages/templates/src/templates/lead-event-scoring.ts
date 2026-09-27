import { defineTemplate } from "../types.js";

export const leadEventScoring = defineTemplate({
  id: "lead-event-scoring",
  title: "Lead and event scoring",
  job: "Score how ready an account is to buy from its recent product events, and pick the next sales action.",
  pattern: "confidence_routing",
  whenToUse: [
    "Product analytics shows what trial or free accounts do, and sales wants to know who to call.",
    "A salesperson can read an account's recent events and say \"call them\" or \"not yet\" in a few seconds.",
  ],
  whenNotToUse: [
    "You need a personalized outreach email. That is text generation; use this set to decide who gets one.",
    "Your scoring rule is arithmetic, such as points per event with a cutoff. Keep it in code.",
    "You want to count events or compare dates. Do that in code and pass the results in the state.",
  ],
  notes: [
    "Pass a short, pre-filtered list of recent events. Drop page views and noise in code first.",
    "Pass counts and time windows your code already computed (for example `seats_invited`) as fields, instead of asking the model to count.",
    "Act on `next_action` only when `overallAction` is `auto`. `buying_intent` does not gate; use it to sort lists.",
    "Replace the `next_action` options with the plays your team runs, and keep `none_needed`.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["account", "events"],
        properties: {
          account: {
            type: "object",
            required: ["plan"],
            properties: {
              company: { type: "string" },
              plan: { type: "string", enum: ["free", "trial", "paid"] },
              seats_invited: { type: "integer", minimum: 0 },
            },
          },
          events: {
            type: "array",
            maxItems: 50,
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                detail: { type: "string" },
              },
            },
          },
        },
      },
    },
    stages: [
      {
        id: "score",
        questions: {
          buying_intent: {
            type: "score",
            instructions:
              "How strongly do the recent product `events` of this `account` show that it intends to buy or upgrade?",
            criteria: [
              "None. Casual or one-off use.",
              "Exploring. Trying features, no sign of a team or a budget.",
              "Evaluating. Several people involved, or they looked at pricing, security or limits.",
              "Ready. Clear buying signals such as hitting plan limits, asking for a quote, or starting checkout.",
            ],
            meta: { label: "Buying intent" },
          },
          next_action: {
            type: "choice",
            instructions:
              "Given the recent product `events` of this `account`, which sales action fits best right now?",
            criteria: {
              sales_call: "The account shows strong intent and would benefit from talking to a person now.",
              send_docs: "The account is evaluating and has a specific open question, such as security, pricing or limits.",
              nurture_email: "The account is active but early. A helpful email keeps it moving.",
              none_needed: "Nothing in the events calls for outreach yet.",
            },
            meta: { label: "Next action" },
          },
        },
      },
    ],
    policies: {
      buying_intent: {
        type: "score",
        gating: false,
        thresholds: { high: 0.6, medium: 0.35 },
        actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } },
      },
      next_action: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.6, medium: 0.35 },
        perOption: { sales_call: { high: 0.7, medium: 0.45 } },
        actions: {
          high: { kind: "auto" },
          medium: { kind: "review" },
          low: { kind: "fallback", config: { kind: "value", value: "none_needed" } },
        },
      },
    },
    routes: [
      { when: { q: "next_action", eq: "sales_call" }, output: "sales_call" },
      { when: { q: "next_action", eq: "send_docs" }, output: "send_docs" },
      { when: { q: "next_action", eq: "nurture_email" }, output: "nurture_email" },
    ],
    defaultRoute: "no_action",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 60, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Trial account hitting limits",
      expect: "High intent, sales_call.",
      state: {
        account: { company: "Northwind Analytics", plan: "trial", seats_invited: 7 },
        events: [
          { name: "plan_limit_reached", detail: "projects" },
          { name: "pricing_page_viewed" },
          { name: "sso_settings_opened" },
          { name: "checkout_started", detail: "team plan" },
        ],
      },
    },
    {
      name: "Single user poking around",
      expect: "Low intent, none_needed or nurture_email.",
      state: {
        account: { plan: "free", seats_invited: 0 },
        events: [{ name: "signed_up" }, { name: "sample_project_opened" }],
      },
    },
  ],
  borderline: {
    buying_intent: {
      why: "Heavy usage by one person on the free plan: engaged, but no sign of a team or a budget.",
      state: {
        account: { plan: "free", seats_invited: 0 },
        events: [
          { name: "project_created" },
          { name: "export_run", detail: "csv" },
          { name: "api_key_created" },
          { name: "project_created" },
        ],
      },
    },
    next_action: {
      why: "They opened the security page and invited teammates: send docs or call?",
      state: {
        account: { company: "Contoso Health", plan: "trial", seats_invited: 3 },
        events: [{ name: "security_page_viewed" }, { name: "teammate_invited" }, { name: "dpa_downloaded" }],
      },
    },
  },
});
