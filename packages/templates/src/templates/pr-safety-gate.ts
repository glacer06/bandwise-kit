import { defineTemplate } from "../types.js";

const HIGH_AUTO_ELSE_REVIEW = { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } as const;
const NOUL_BARS = { trueAt: 0.8, falseAt: 0.2, reviewMargin: 0.1 } as const;

export const prSafetyGate = defineTemplate({
  id: "pr-safety-gate",
  title: "PR safety gate",
  job: "Decide whether a pull request is safe to merge without a human reviewer.",
  pattern: "composite_scoring",
  whenToUse: [
    "Bots or agents open many small pull requests (dependency bumps, generated fixes, copy changes) and you want the safe ones merged without waiting.",
    "Your team can name the risks that always need a person: sensitive code, weakened tests, destructive migrations, changes that mix several concerns.",
  ],
  whenNotToUse: [
    "You want a code review with comments. That is text generation; keep an LLM or a person for it.",
    "Your branch protection already requires a human review on every pull request. Change that policy first.",
    "The only rule is size. Diff size is a number, so compare it in code (this template does that in a check).",
  ],
  notes: [
    "Merge only when `overallAction` is `auto` and `route` is `auto_merge`. Anything else waits for a person.",
    "`large_diff` is a code check on `pr.lines_changed`, not a model question. Change the 400 line limit to suit your repo.",
    "Replace the sensitive areas in `touches_sensitive_code` with your own (auth, billing, permissions, secrets, infrastructure).",
    "CI still has to pass. This set decides on review, not on correctness.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["pr"],
        properties: {
          pr: {
            type: "object",
            required: ["title", "files", "diff", "lines_changed"],
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              diff: { type: "string" },
              lines_changed: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    checks: [{ id: "large_diff", when: { input: "pr.lines_changed", gte: 400 } }],
    stages: [
      {
        id: "risks",
        questions: {
          touches_sensitive_code: {
            type: "noul",
            instructions:
              "Does the change in `pr.diff` (files `pr.files`) modify authentication, authorization, billing, payments, secrets handling, or permission checks?",
            criteria: {
              true: "At least one changed line sits in code that decides who can do what, handles money, or handles credentials.",
              false: "The changed lines are outside those areas, such as copy, styling, docs, or unrelated features.",
            },
            meta: { label: "Touches sensitive code" },
          },
          tests_weakened: {
            type: "noul",
            instructions:
              "Does `pr.diff` delete tests, skip tests, loosen assertions, or lower a coverage or lint threshold?",
            criteria: {
              true: "Existing checks were removed, skipped, or made easier to pass.",
              false: "Tests were added, kept, or made stricter, or the change touches no tests.",
            },
            meta: { label: "Tests weakened" },
          },
          risky_migration: {
            type: "noul",
            instructions:
              "Does `pr.diff` include a database or schema migration that drops, renames, or rewrites existing columns, tables, or data?",
            criteria: {
              true: "A migration changes or removes existing data or structure in a way that is hard to undo.",
              false: "Migrations only add new tables, columns, or indexes, or the change has no migration.",
            },
            meta: { label: "Risky migration" },
          },
          mixed_concerns: {
            type: "noul",
            instructions:
              "Judged by `pr.title`, `pr.description` and `pr.diff`, does this pull request mix several unrelated changes that a reviewer would want split up?",
            criteria: {
              true: "Several unrelated changes are bundled, so a reviewer could miss one.",
              false: "The change has one clear purpose.",
            },
            meta: { label: "Mixes unrelated changes" },
          },
        },
      },
    ],
    policies: {
      touches_sensitive_code: { type: "noul", gating: true, noul: NOUL_BARS, actions: HIGH_AUTO_ELSE_REVIEW },
      tests_weakened: { type: "noul", gating: true, noul: NOUL_BARS, actions: HIGH_AUTO_ELSE_REVIEW },
      risky_migration: { type: "noul", gating: true, noul: NOUL_BARS, actions: HIGH_AUTO_ELSE_REVIEW },
      mixed_concerns: { type: "noul", gating: true, noul: NOUL_BARS, actions: HIGH_AUTO_ELSE_REVIEW },
    },
    composites: [
      {
        id: "risk",
        kind: "weighted",
        terms: [
          { q: "touches_sensitive_code", weight: 0.3 },
          { q: "tests_weakened", weight: 0.25 },
          { q: "risky_migration", weight: 0.25 },
          { q: "mixed_concerns", weight: 0.1 },
          { check: "large_diff", weight: 0.1 },
        ],
        policy: {
          type: "composite",
          gating: true,
          levelThresholds: { high: 0.5, medium: 0.2 },
          actions: { high: { kind: "review" }, medium: { kind: "review" }, low: { kind: "auto" } },
        },
      },
    ],
    routes: [
      {
        when: {
          any: [
            { q: "touches_sensitive_code", eq: true },
            { q: "tests_weakened", eq: true },
            { q: "risky_migration", eq: true },
            { check: "large_diff" },
          ],
        },
        output: "needs_human",
      },
      { when: { composite: "risk", gte: 0.2 }, output: "needs_human" },
    ],
    defaultRoute: "auto_merge",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 60, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Dependency patch bump",
      expect: "auto_merge: one purpose, no sensitive code, no tests touched.",
      state: {
        pr: {
          title: "Bump date-fns from 3.6.0 to 3.6.1",
          description: "Patch release with a timezone parsing fix.",
          files: ["package.json", "pnpm-lock.yaml"],
          diff: "-    \"date-fns\": \"3.6.0\"\n+    \"date-fns\": \"3.6.1\"",
          lines_changed: 14,
        },
      },
    },
    {
      name: "Permission check change",
      expect: "needs_human: it changes who can delete a project.",
      state: {
        pr: {
          title: "Let editors delete projects",
          description: "Product asked for editors to be able to clean up old projects.",
          files: ["src/auth/permissions.ts", "src/auth/permissions.test.ts"],
          diff: "-  delete: [\"owner\", \"admin\"],\n+  delete: [\"owner\", \"admin\", \"editor\"],",
          lines_changed: 6,
        },
      },
    },
    {
      name: "Skipped flaky test",
      expect: "needs_human: a test was skipped to get the build green.",
      state: {
        pr: {
          title: "Fix CI",
          description: "The checkout test is flaky, skipping it for now.",
          files: ["tests/checkout.spec.ts"],
          diff: "-  it(\"charges the saved card\", async () => {\n+  it.skip(\"charges the saved card\", async () => {",
          lines_changed: 2,
        },
      },
    },
  ],
  borderline: {
    touches_sensitive_code: {
      why: "A logging change inside the auth module that does not change any decision.",
      state: {
        pr: {
          title: "Log failed logins at info level",
          files: ["src/auth/login.ts"],
          diff: "-    logger.debug(\"login failed\", { userId })\n+    logger.info(\"login failed\", { userId })",
          lines_changed: 2,
        },
      },
    },
    tests_weakened: {
      why: "A snapshot was regenerated: the assertion still exists but now expects new output.",
      state: {
        pr: {
          title: "Update invoice snapshot",
          description: "The invoice footer copy changed.",
          files: ["tests/__snapshots__/invoice.test.ts.snap"],
          diff: "-  \"Thanks for your business\"\n+  \"Thank you for your business\"",
          lines_changed: 2,
        },
      },
    },
    risky_migration: {
      why: "Adds a NOT NULL column with a default, which rewrites a large table on some databases.",
      state: {
        pr: {
          title: "Add status to orders",
          files: ["migrations/0042_order_status.sql"],
          diff: "+ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'open';",
          lines_changed: 1,
        },
      },
    },
    mixed_concerns: {
      why: "A feature plus a small drive-by rename in a file the feature also touches.",
      state: {
        pr: {
          title: "Add CSV export",
          description: "Adds CSV export to reports. Also renames fmt to formatCell while I was there.",
          files: ["src/reports/export.ts", "src/reports/format.ts"],
          diff: "+export function toCsv(rows) { ... }\n-function fmt(cell) {\n+function formatCell(cell) {",
          lines_changed: 58,
        },
      },
    },
  },
});
