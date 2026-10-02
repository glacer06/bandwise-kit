// @ts-check
/**
 * Shared ESLint flat config for the kit packages.
 * Entry point: `import bandwise from "@bandwise/config/eslint"; export default bandwise;`
 * Pure packages (core, templates) use `pure` instead.
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export const ignores = [
  {
    name: "bandwise/ignores",
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/__fixtures__/**"],
  },
];

/** @type {import("eslint").Linter.Config[]} */
/** Only src/live/spawn.ts may start another program: the agent that bandwise launch starts. */
const NO_CHILD_PROCESS = ["child_process", "node:child_process"].map((name) => ({
  name,
  message: "Only src/live/spawn.ts starts a program.",
}));

const bandwise = [
  ...ignores,
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    name: "bandwise/base",
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // The CLI's local mode runs on the fixture transport only. It must never load the SDK.
    name: "bandwise/cli-local",
    files: ["src/local/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@bandwise/system-one-client", message: "Local mode imports @bandwise/system-one-client/fixture only." },
            { name: "@typesafe-ai/sdk", message: "Local mode never loads the TypeSafe SDK." },
            ...NO_CHILD_PROCESS,
          ],
        },
      ],
    },
  },
  {
    // Live mode loads the SDK transport through live/transport.ts only. The shared runner never does.
    // Only live/spawn.ts starts another program.
    name: "bandwise/cli-live",
    files: ["src/live/**/*.ts", "src/runner/**/*.ts"],
    ignores: ["**/*.test.ts", "src/live/transport.ts", "src/live/spawn.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@bandwise/system-one-client", message: "Only src/live/transport.ts loads the SDK transport." },
            { name: "@bandwise/system-one-client/fixture", message: "Live mode and the runner never use the fixture transport." },
            { name: "@typesafe-ai/sdk", message: "Only @bandwise/system-one-client imports the TypeSafe SDK." },
            ...NO_CHILD_PROCESS,
          ],
        },
      ],
    },
  },
  {
    // The rest of the CLI (main.ts, receipts, hooks install) never starts a program either.
    name: "bandwise/cli-no-spawn",
    files: ["src/*.ts", "src/receipts/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [...NO_CHILD_PROCESS] }],
    },
  },
  {
    // spawn.ts starts the agent and imports nothing that reaches the SDK.
    name: "bandwise/cli-spawn",
    files: ["src/live/spawn.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@bandwise/system-one-client", message: "spawn.ts starts a program and never loads the SDK transport." },
            { name: "@typesafe-ai/sdk", message: "Only @bandwise/system-one-client imports the TypeSafe SDK." },
          ],
        },
      ],
    },
  },
];

export default bandwise;

// ---------------------------------------------------------------------------
// Purity: core and templates have no I/O, clock, randomness, timers, env or network of their
// own. They import only zod and, for templates, @bandwise/core.

const PURITY_MESSAGE = "is not allowed in a pure package (core, templates). Take it as an argument.";

const restrictedGlobals = [
  "process",
  "Buffer",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "fetch",
  "crypto",
  "performance",
  "require",
  "__dirname",
  "__filename",
  "globalThis",
].map((name) => ({ name, message: `${name} ${PURITY_MESSAGE}` }));

const restrictedProperties = [
  { object: "Date", property: "now" },
  { object: "Math", property: "random" },
  { object: "crypto", property: "randomUUID" },
  { object: "crypto", property: "getRandomValues" },
  { object: "performance", property: "now" },
].map(({ object, property }) => ({ object, property, message: `${object}.${property}() ${PURITY_MESSAGE}` }));

const restrictedSyntax = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: `new Date() ${PURITY_MESSAGE}` },
  { selector: "CallExpression[callee.name='Date']", message: `Date() ${PURITY_MESSAGE}` },
];

/** @type {import("eslint").Linter.Config[]} */
export const purityConfig = [
  {
    name: "bandwise/purity",
    files: ["src/**/*.{js,mjs,cjs,ts,mts,cts,tsx,jsx}"],
    ignores: ["**/*.test.{ts,tsx,js}", "**/test/**", "**/__fixtures__/**"],
    rules: {
      "no-restricted-globals": ["error", ...restrictedGlobals],
      "no-restricted-properties": ["error", ...restrictedProperties],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!zod$|@bandwise/core(/contracts)?$|\\.{1,2}/)",
              message: "A pure package imports only zod, @bandwise/core and its own files.",
            },
          ],
        },
      ],
    },
  },
];

/** The shared config plus the purity rules, for core and templates. */
export const pure = [...bandwise, ...purityConfig];
