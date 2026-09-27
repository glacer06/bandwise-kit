import { defineBandwiseVitestConfig } from "@bandwise/config/vitest";

// The confidence router and the spec compiler keep 100% branch coverage.
// The router is router.ts plus the files it decides with: the
// normative effective-action table, answer reading, the question-type band rules and the condition
// evaluator. The compiler is compiler.ts plus preflight.ts and the question-type compile functions.
const FULL = { branches: 100, functions: 100, lines: 100, statements: 100 };

export default defineBandwiseVitestConfig({
  test: {
    coverage: {
      enabled: true,
      reporter: ["text-summary", "json-summary"],
      exclude: ["**/*.test.{ts,tsx}", "**/__fixtures__/**", "src/test/**"],
      thresholds: {
        "src/engine/router.ts": FULL,
        "src/engine/effective-action.ts": FULL,
        "src/engine/answers.ts": FULL,
        "src/engine/compiler.ts": FULL,
        "src/engine/preflight.ts": FULL,
        "src/conditions/evaluate.ts": FULL,
        "src/question-types/*.ts": FULL,
      },
    },
  },
});
