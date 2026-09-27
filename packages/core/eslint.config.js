import { pure } from "@bandwise/config/eslint";

export default [
  ...pure,
  {
    // Table-driven tests index fixed test data; a missing entry fails the test either way.
    name: "bandwise/core-tests",
    files: ["src/**/*.test.ts", "src/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
];
