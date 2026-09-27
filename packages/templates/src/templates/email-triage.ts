import { defineTemplate } from "../types.js";

const me = { name: "Sam", known_contacts: ["ana@example.com", "legal@example.com", "lee@example.org"] };

export const emailTriage = defineTemplate({
  id: "email-triage",
  title: "Email triage",
  job: "Decide whether an email needs the recipient soon, and what kind of message it is.",
  pattern: "composite_scoring",
  whenToUse: [
    "An inbox or shared mailbox where people lose time sorting mail by hand.",
    "You already ask an LLM \"is this urgent?\" and act on a yes or no.",
    "Urgency means a person wrote it, someone is waiting, and ignoring it costs something.",
  ],
  whenNotToUse: [
    "You need a reply drafted. That is text generation; keep an LLM for it and use this set to decide which mail gets one.",
    "The rule is exact, such as a sender domain or a subject tag. Keep that in code or in a spec check.",
  ],
  notes: [
    "App code branches on `overallAction` first. Act only on `auto`; `review` goes to a person.",
    "Then read `route`: `urgent`, `read_later` or `normal`.",
    "The `urgency` composite weighs three checks. Tune the weights and `levelThresholds` on your own labeled mail.",
    "`work_type` is speculative: it only counts when `category` is `work_request`.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["email", "me"],
        properties: {
          email: {
            type: "object",
            required: ["from", "subject", "body"],
            properties: {
              from: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
              signature: { type: "string" },
            },
          },
          me: {
            type: "object",
            properties: {
              name: { type: "string" },
              known_contacts: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      redactPaths: ["email.signature"],
    },
    stages: [
      {
        id: "triage",
        questions: {
          real_person: {
            type: "noul",
            instructions:
              "Was `email` written by a real person to the recipient, rather than sent by an automated system, newsletter, or marketing tool?",
            criteria: {
              true: "A person wrote this message to the recipient.",
              false: "Automated, bulk, newsletter, receipt, or marketing mail.",
            },
            meta: { label: "Real person wrote it" },
          },
          someone_waiting: {
            type: "noul",
            instructions: {
              question: "Is someone the recipient knows waiting on the recipient to reply or act?",
              recipient: "`me.name`",
              known_contacts: "`me.known_contacts`",
              email: "`email`",
            },
            criteria: {
              true: "The sender or someone named is blocked on, or explicitly waiting for, the recipient.",
              false: "Nobody is waiting on the recipient.",
            },
            meta: { label: "Someone is waiting" },
          },
          cost_of_ignoring: {
            type: "score",
            instructions: "What will it cost the recipient to ignore `email` for a week?",
            criteria: [
              "Nothing. Safe to ignore.",
              "Minor. A small delay or a mildly annoyed contact.",
              "Real. A missed deadline, lost money, or a damaged relationship.",
              "Severe. Legal, financial, or safety consequences.",
            ],
            meta: { label: "Cost of ignoring" },
          },
          category: {
            type: "choice",
            instructions: "What kind of message is `email`, judged by what the sender wants from the recipient?",
            criteria: {
              work_request: "Someone needs work, a decision, or information from the recipient.",
              scheduling: "Meeting times, invites, or calendar changes.",
              personal: "Friends or family.",
              newsletter: "Subscribed content or digests.",
              transactional: "Receipts, notifications, password resets.",
              none_of_these: null,
            },
            meta: { label: "Category" },
          },
          work_type: {
            type: "choice",
            instructions:
              "Assume `email` is a work request to the recipient. What does the sender need the recipient to do?",
            criteria: {
              decision: "Make or approve a decision.",
              information: "Send facts, an answer, or a document.",
              review: "Review or give feedback on something the sender made.",
              none_of_these: null,
            },
            meta: { label: "Work type", description: "Speculative: only relevant when category is work_request." },
          },
        },
      },
    ],
    policies: {
      real_person: {
        type: "noul",
        gating: true,
        noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
        actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "review" } },
      },
      someone_waiting: {
        type: "noul",
        gating: true,
        noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
      cost_of_ignoring: {
        type: "score",
        gating: true,
        thresholds: { high: 0.7, medium: 0.45 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
      category: {
        type: "choice",
        gating: false,
        thresholds: { high: 0.6, medium: 0.3 },
        actions: {
          high: { kind: "auto" },
          medium: { kind: "auto" },
          low: { kind: "fallback", config: { kind: "value", value: "none_of_these" } },
        },
      },
      work_type: {
        type: "choice",
        gating: true,
        relevantWhen: { q: "category", eq: "work_request" },
        thresholds: { high: 0.65, medium: 0.4 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    },
    composites: [
      {
        id: "urgency",
        kind: "weighted",
        terms: [
          { q: "real_person", weight: 0.25 },
          { q: "someone_waiting", weight: 0.35 },
          { q: "cost_of_ignoring", weight: 0.4 },
        ],
        policy: {
          type: "composite",
          gating: true,
          levelThresholds: { high: 0.7, medium: 0.4 },
          actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "auto" } },
        },
      },
    ],
    routes: [
      { when: { composite: "urgency", gte: 0.7 }, output: "urgent" },
      { when: { q: "category", eq: "newsletter" }, output: "read_later" },
    ],
    defaultRoute: "normal",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 60, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Contract approval from a known contact",
      expect: "Urgent: a person wrote it, they are waiting, and a missed deadline costs money.",
      state: {
        email: {
          from: "ana@example.com",
          subject: "Re: contract renewal",
          body: "Hi Sam, legal signed off on the renewal terms. I need your approval on the final contract by Friday so we can keep the current pricing. Can you confirm today?",
          signature: "Ana, Procurement",
        },
        me,
      },
    },
    {
      name: "Weekly newsletter",
      expect: "Read later: automated mail, nobody waiting, nothing lost by ignoring it.",
      state: {
        email: {
          from: "digest@news.example.net",
          subject: "This week in data engineering",
          body: "Five articles we liked this week, plus a new podcast episode. You are receiving this because you subscribed.",
        },
        me,
      },
    },
    {
      name: "Meeting move from a colleague",
      expect: "Normal: a person wrote it about scheduling, and a week's delay costs little.",
      state: {
        email: {
          from: "lee@example.org",
          subject: "Moving our 1:1",
          body: "Hey Sam, can we push Thursday's 1:1 to next week? No rush, whenever suits you.",
        },
        me,
      },
    },
  ],
  borderline: {
    real_person: {
      why: "A sales sequence tool sent it, but it is written in the first person and uses the recipient's name.",
      state: {
        email: {
          from: "jordan@vendor.example.com",
          subject: "Quick question, Sam",
          body: "Hi Sam, I noticed your team is hiring data engineers. Would a 15 minute call next week make sense? Jordan",
        },
        me,
      },
    },
    someone_waiting: {
      why: "An FYI that ends with an open invitation, not a request.",
      state: {
        email: {
          from: "lee@example.org",
          subject: "Notes from the planning session",
          body: "Sharing my notes from today. Let me know if you have thoughts.",
        },
        me,
      },
    },
    cost_of_ignoring: {
      why: "A payment reminder with a due date weeks away: minor now, real later.",
      state: {
        email: {
          from: "billing@saas.example.com",
          subject: "Your invoice is due in 3 weeks",
          body: "Invoice 2291 for 480 USD is due at the end of next month. Late payments pause the account.",
        },
        me,
      },
    },
    category: {
      why: "A meeting invite that also asks for a decision before the meeting.",
      state: {
        email: {
          from: "ana@example.com",
          subject: "Vendor review Tuesday",
          body: "Sending an invite for Tuesday. Before then, please pick which of the two vendors we should drop.",
        },
        me,
      },
    },
    work_type: {
      why: "\"Take a look and sign off\" is both a review and an approval.",
      state: {
        email: {
          from: "legal@example.com",
          subject: "NDA for the partner pilot",
          body: "Attached is the NDA. Can you take a look and sign off so we can send it today?",
        },
        me,
      },
    },
  },
});
