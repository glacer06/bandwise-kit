import { defineTemplate } from "../types.js";

const release = {
  version: "2026.9.3",
  changes: [
    "checkout: switch tax calculation to the new rates service",
    "search: add typo tolerance",
    "deps: bump the image resizing library",
  ],
};

export const errorTriage = defineTemplate({
  id: "error-triage",
  title: "Error triage",
  job: "Decide which team owns a new error tracker issue, how much it hurts users, and whether the latest release caused it.",
  pattern: "fan_out",
  whenToUse: [
    "New issues from your error tracker sit unassigned because nobody knows whose they are.",
    "An engineer can tell the owner and the impact from the title, stack trace and release notes in a few seconds.",
  ],
  whenNotToUse: [
    "You need a root cause analysis or a fix. That takes longer than 10 seconds and is text generation.",
    "Ownership follows file paths exactly, such as a CODEOWNERS file. Look it up in code.",
    "The impact is a number you already have, such as affected users per hour. Threshold it in code.",
  ],
  notes: [
    "Replace the `owning_team` options with your own teams, and keep `none_of_these`.",
    "Assign only when `overallAction` is `auto`. Route `page` goes to on-call, `regression` to the release owner, `backlog` to the owning team's queue.",
    "`release.changes` should list the changes in the latest release, one line each. The regression question compares the issue against that list, not against dates.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["issue", "release"],
        properties: {
          issue: {
            type: "object",
            required: ["title", "culprit", "stack"],
            properties: {
              title: { type: "string" },
              culprit: { type: "string" },
              stack: { type: "string", maxLength: 8000 },
              url_path: { type: "string" },
            },
          },
          release: {
            type: "object",
            required: ["version", "changes"],
            properties: {
              version: { type: "string" },
              changes: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    stages: [
      {
        id: "triage",
        questions: {
          owning_team: {
            type: "choice",
            instructions:
              "Which team owns the code that raised `issue`, judged from its title, culprit and stack trace?",
            criteria: {
              web_frontend: "Browser code: pages, components, client-side state.",
              checkout_and_billing: "Carts, payments, taxes, invoices and subscriptions.",
              search: "Search indexing, ranking and query handling.",
              platform: "Auth, databases, queues, deploys and shared infrastructure.",
              none_of_these: null,
            },
            meta: { label: "Owning team" },
          },
          user_impact: {
            type: "score",
            instructions: "How badly does `issue` hurt the people using the product when it happens?",
            criteria: [
              "None. Users do not notice.",
              "Minor. A cosmetic glitch or a retry that works.",
              "Major. A feature fails for the user, with a workaround.",
              "Blocking. Users cannot finish a core task such as signing in or paying.",
            ],
            meta: { label: "User impact" },
          },
          new_regression: {
            type: "noul",
            instructions:
              "Is `issue` likely caused by one of the changes shipped in the latest release, listed in `release.changes`?",
            criteria: {
              true: "The stack trace or culprit points at code one of the listed changes touched.",
              false: "The failing code is unrelated to every listed change.",
            },
            meta: { label: "New regression" },
          },
        },
      },
    ],
    policies: {
      owning_team: {
        type: "choice",
        gating: true,
        thresholds: { high: 0.65, medium: 0.4 },
        actions: {
          high: { kind: "auto" },
          medium: { kind: "review" },
          low: { kind: "fallback", config: { kind: "value", value: "none_of_these" } },
        },
      },
      user_impact: {
        type: "score",
        gating: true,
        thresholds: { high: 0.6, medium: 0.35 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
      new_regression: {
        type: "noul",
        gating: false,
        noul: { trueAt: 0.75, falseAt: 0.25, reviewMargin: 0.1 },
        actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } },
      },
    },
    routes: [
      { when: { q: "user_impact", eq: 3 }, output: "page" },
      { when: { q: "new_regression", eq: true }, output: "regression" },
    ],
    defaultRoute: "backlog",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 60, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Tax lookup failing at checkout",
      expect: "checkout_and_billing, blocking, a regression from the tax change: page.",
      state: {
        issue: {
          title: "TypeError: Cannot read properties of undefined (reading 'rate')",
          culprit: "checkout/tax.ts in computeTax",
          stack: "at computeTax (checkout/tax.ts:41)\nat buildOrder (checkout/order.ts:88)\nat POST /api/checkout",
          url_path: "/checkout",
        },
        release,
      },
    },
    {
      name: "Avatar image fails to load",
      expect: "web_frontend, minor, not related to the release: backlog.",
      state: {
        issue: {
          title: "Failed to load resource: avatar.png 404",
          culprit: "components/Avatar.tsx",
          stack: "at Avatar (components/Avatar.tsx:12)",
          url_path: "/settings/profile",
        },
        release,
      },
    },
  ],
  borderline: {
    owning_team: {
      why: "A database timeout raised inside search code: platform owns the database, search owns the query.",
      state: {
        issue: {
          title: "QueryTimeout: statement timeout after 30000ms",
          culprit: "search/indexer.ts in reindexBatch",
          stack: "at pool.query (db/pool.ts:20)\nat reindexBatch (search/indexer.ts:64)",
        },
        release,
      },
    },
    user_impact: {
      why: "Search results come back without typo tolerance: the feature degrades but still works.",
      state: {
        issue: {
          title: "Warning: fuzzy matcher unavailable, falling back to exact match",
          culprit: "search/query.ts",
          stack: "at runQuery (search/query.ts:102)",
          url_path: "/search",
        },
        release,
      },
    },
    new_regression: {
      why: "The failing code sits next to a changed library, but the error is in code the release did not touch.",
      state: {
        issue: {
          title: "Error: unsupported image format 'heic'",
          culprit: "media/upload.ts",
          stack: "at detectFormat (media/upload.ts:33)\nat resize (node_modules/image-lib/index.js:210)",
          url_path: "/upload",
        },
        release,
      },
    },
  },
});
