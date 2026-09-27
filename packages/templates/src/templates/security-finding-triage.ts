import { defineTemplate } from "../types.js";

export const securityFindingTriage = defineTemplate({
  id: "security-finding-triage",
  title: "Security finding triage",
  job: "Decide whether a static analysis finding is reachable from user input, and how bad it is in context.",
  pattern: "confidence_routing",
  whenToUse: [
    "A code scanner reports more findings than your team can read, and most are false positives in practice.",
    "A reviewer can tell from the finding, the code around it and where its input comes from whether it matters.",
  ],
  whenNotToUse: [
    "You need a fix written. That is text generation; keep an LLM or a person for it.",
    "Deciding reachability needs a whole-program trace across many files. Run a taint analysis tool, then use this set on its output.",
    "The rule is exact, such as closing every finding in test files. Do that in code before the call.",
  ],
  notes: [
    "Auto-close only when `overallAction` is `auto` and `route` is `auto_close`. That happens only for a high band \"not reachable\". Everything else goes to a person.",
    "`severity_in_context` does not gate. Use its value to order the review queue.",
    "Put the code around the finding and where its inputs come from in `finding.context`. Without them the set cannot judge reachability.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["finding"],
        properties: {
          finding: {
            type: "object",
            required: ["rule", "message", "file", "context"],
            properties: {
              rule: { type: "string" },
              message: { type: "string" },
              file: { type: "string" },
              context: { type: "string", maxLength: 12000 },
              service_exposure: { type: "string", enum: ["internet", "internal", "offline"] },
            },
          },
        },
      },
    },
    stages: [
      {
        id: "triage",
        questions: {
          reachable_from_user_input: {
            type: "noul",
            instructions:
              "Can data an outside user controls reach the flagged code in `finding` (rule `finding.rule` in `finding.file`), judged from the code and data flow in `finding.context`?",
            criteria: {
              true: "User-controlled data such as a request body, query, header, upload or message can flow to the flagged line.",
              false: "Only constants, trusted configuration, or internal values the user cannot influence reach the flagged line.",
            },
            meta: { label: "Reachable from user input" },
          },
          severity_in_context: {
            type: "score",
            instructions:
              "If an attacker could trigger `finding`, how much harm could it cause in this codebase, judged from `finding.context` and `finding.service_exposure`?",
            criteria: [
              "Informational. No realistic harm.",
              "Low. Limited information exposure or a nuisance.",
              "High. Access to other users' data, or a way to disrupt the service.",
              "Critical. Remote code execution, full data access, or account takeover.",
            ],
            meta: { label: "Severity in context" },
          },
        },
      },
    ],
    policies: {
      reachable_from_user_input: {
        type: "noul",
        gating: true,
        noul: { trueAt: 0.8, falseAt: 0.1, reviewMargin: 0.05 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
      severity_in_context: {
        type: "score",
        gating: false,
        thresholds: { high: 0.6, medium: 0.35 },
        actions: { high: { kind: "auto" }, medium: { kind: "auto" }, low: { kind: "auto" } },
      },
    },
    routes: [
      {
        when: {
          all: [
            { q: "reachable_from_user_input", eq: false },
            { q: "reachable_from_user_input", band: "high" },
          ],
        },
        output: "auto_close",
      },
    ],
    defaultRoute: "review",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 60, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "SQL built from a request parameter",
      expect: "review: user input reaches the query.",
      state: {
        finding: {
          rule: "sql-injection",
          message: "Query built with string concatenation.",
          file: "src/routes/search.ts",
          context:
            "router.get('/search', (req, res) => {\n  const q = req.query.q;\n  db.query(\"SELECT * FROM items WHERE name LIKE '%\" + q + \"%'\");\n});",
          service_exposure: "internet",
        },
      },
    },
    {
      name: "Shell call with a constant",
      expect: "auto_close: only a constant reaches the call.",
      state: {
        finding: {
          rule: "command-injection",
          message: "Call to exec with a non-literal argument.",
          file: "scripts/backup.ts",
          context: "const BACKUP_CMD = 'pg_dump --format=custom app';\nexec(BACKUP_CMD);",
          service_exposure: "offline",
        },
      },
    },
  ],
  borderline: {
    reachable_from_user_input: {
      why: "The value comes from a config file that admins can edit through the product's settings page.",
      state: {
        finding: {
          rule: "path-traversal",
          message: "File path built from a variable.",
          file: "src/export/write.ts",
          context:
            "const dir = settings.get('export_dir'); // editable by org admins in Settings\nfs.writeFileSync(path.join(dir, name), data);",
          service_exposure: "internet",
        },
      },
    },
    severity_in_context: {
      why: "An open redirect on a login page: low on its own, higher when used for phishing.",
      state: {
        finding: {
          rule: "open-redirect",
          message: "Redirect to a URL taken from the request.",
          file: "src/routes/login.ts",
          context: "res.redirect(req.query.next || '/');",
          service_exposure: "internet",
        },
      },
    },
  },
});
