// @ts-check
/**
 * Shared Vitest preset.
 * Usage in a package: `export default defineBandwiseVitestConfig();`
 * The "@bandwise/source" condition makes workspace imports resolve to src/, so tests never need a build.
 */
import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";

const sourceCondition = "@bandwise/source";

/** @type {import("vitest/config").ViteUserConfig} */
export const vitestPreset = defineConfig({
  resolve: {
    conditions: [sourceCondition, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [sourceCondition, ...defaultServerConditions],
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/__fixtures__/**"],
    environment: "node",
    passWithNoTests: false,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/__fixtures__/**"],
    },
  },
});

/**
 * Merge package-specific options over the preset.
 * @param {import("vitest/config").ViteUserConfig} [overrides]
 * @returns {import("vitest/config").ViteUserConfig}
 */
export function defineBandwiseVitestConfig(overrides = {}) {
  return mergeConfig(vitestPreset, overrides);
}
