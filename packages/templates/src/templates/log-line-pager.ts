import { defineTemplate } from "../types.js";

export const logLinePager = defineTemplate({
  id: "log-line-pager",
  title: "Log-line pager",
  job: "Decide whether one log line needs a human now, so only real problems page someone.",
  pattern: "confidence_routing",
  whenToUse: [
    "Alerting on error logs pages people for noise, and regex rules keep growing.",
    "A person on call can tell in a few seconds whether a line matters.",
  ],
  whenNotToUse: [
    "You need a root cause or a summary of an incident. That takes longer than 10 seconds and is text generation.",
    "The rule is a threshold on a metric, such as error rate above 5 percent. Keep that in your metrics system.",
    "Volume is so high that a model call per line is too slow or costly. Sample or group lines in code first.",
  ],
  notes: [
    "Page only when `overallAction` is `auto` and `route` is `page`. Send `review` to a queue someone reads during working hours, not to the pager.",
    "`fatal_level` is a code check: lines at fatal or critical level always route to `page`.",
    "Tune `trueAt` on your own labeled lines. Raise it to page less, lower it to miss less.",
    "One run per line. Group repeated lines in code before calling the set.",
  ],
  spec: {
    schemaVersion: 1,
    model: "jev-1.13.0",
    input: {
      schema: {
        type: "object",
        required: ["log", "service"],
        properties: {
          log: {
            type: "object",
            required: ["level", "message"],
            properties: {
              level: { type: "string", enum: ["debug", "info", "warn", "error", "fatal", "critical"] },
              message: { type: "string", maxLength: 4000 },
            },
          },
          service: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              purpose: { type: "string" },
            },
          },
          recent_lines: { type: "array", items: { type: "string" }, maxItems: 20 },
        },
      },
    },
    checks: [{ id: "fatal_level", when: { input: "log.level", in: ["fatal", "critical"] } }],
    stages: [
      {
        id: "page",
        questions: {
          needs_human_now: {
            type: "noul",
            instructions: {
              question:
                "Does this log line show a problem that a person on call should look at right now, because users, data, or money are affected or soon will be?",
              log_line: "`log`",
              service_info: "`service`",
              recent_lines_for_context: "`recent_lines`",
            },
            criteria: {
              true: "A real, current problem: failed payments, data loss, an outage, a security event, or errors users will see.",
              false: "Expected noise, a handled retry, a single transient failure, a deprecation notice, or a problem that can wait for working hours.",
            },
            meta: { label: "Needs a human now" },
          },
        },
      },
    ],
    policies: {
      needs_human_now: {
        type: "noul",
        gating: true,
        noul: { trueAt: 0.8, falseAt: 0.2, reviewMargin: 0.1 },
        actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } },
      },
    },
    routes: [
      { when: { any: [{ check: "fatal_level" }, { q: "needs_human_now", eq: true }] }, output: "page" },
    ],
    defaultRoute: "log_only",
    savings: { comparatorModel: "claude-haiku-4-5", estOutputTokensPerQuestion: 40, kind: "decision" },
    onUnavailable: "review",
  },
  examples: [
    {
      name: "Payment provider failures",
      expect: "page: customers cannot pay.",
      state: {
        log: { level: "error", message: "charge failed: provider returned 503 for 42 of the last 50 attempts" },
        service: { name: "checkout-api", purpose: "Takes payments for orders." },
        recent_lines: ["charge failed: provider returned 503", "charge failed: provider returned 503"],
      },
    },
    {
      name: "Handled retry",
      expect: "log_only: the retry worked.",
      state: {
        log: { level: "warn", message: "redis connection reset, retrying (attempt 1 of 3); reconnected" },
        service: { name: "session-cache", purpose: "Caches user sessions." },
      },
    },
  ],
  borderline: {
    needs_human_now: {
      why: "A disk warning that is not urgent yet, on a service that holds data.",
      state: {
        log: { level: "warn", message: "volume /var/lib/postgres at 86 percent capacity" },
        service: { name: "orders-db", purpose: "Primary database for orders." },
      },
    },
  },
});
