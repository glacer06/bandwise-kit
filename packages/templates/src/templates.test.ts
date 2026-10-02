import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "@bandwise/cli";
import {
  Pattern,
  RunResult,
  SEED_MODEL_PROFILES,
  lint,
  onUnavailableOf,
  parseSpec,
  specQuestions,
  validateJsonSchema,
} from "@bandwise/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEMPLATES, TEMPLATE_IDS, getTemplate } from "./index.js";
import type { Template } from "./types.js";

/**
 * Lint warnings a template keeps on purpose. `policy.all_gating_thresholded` suggests the top-choice
 * preset; these sets route work where a wrong pick is not cheap, so their choice stays gating.
 */
const EXPECTED_WARNINGS: Record<string, string[]> = {
  "wake-gate": ["policy.all_gating_thresholded"],
  "done-check": ["policy.all_gating_thresholded"],
  "inbound-email-routing": ["policy.all_gating_thresholded"],
  "launch-profile": ["policy.all_gating_thresholded"],
};

const each = TEMPLATES.map((t) => [t.id, t] as const);

/** Every state a template ships: its examples, then one borderline case per question. */
function statesOf(t: Template): Array<{ label: string; state: unknown }> {
  return [
    ...t.examples.map((e) => ({ label: `example "${e.name}"`, state: e.state })),
    ...Object.entries(t.borderline).map(([qid, b]) => ({ label: `borderline ${qid}`, state: b.state })),
  ];
}

describe("template pack", () => {
  it("has unique ids in kebab case", () => {
    expect(new Set(TEMPLATE_IDS).size).toBe(TEMPLATE_IDS.length);
    for (const id of TEMPLATE_IDS) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(getTemplate("wake-gate")?.title).toBe("Wake gate");
    expect(getTemplate("nope")).toBeNull();
  });

  it("covers the kit templates, the triage pack and the agent pack", () => {
    expect([...TEMPLATE_IDS].sort()).toEqual(
      [
        "action-risk-gate",
        "context-pruner",
        "done-check",
        "email-triage",
        "error-triage",
        "inbound-email-routing",
        "launch-profile",
        "lead-event-scoring",
        "log-line-pager",
        "model-tier",
        "pr-safety-gate",
        "security-finding-triage",
        "wake-gate",
      ].sort(),
    );
  });
});

describe.each(each)("%s", (_id, t) => {
  it("carries its metadata", () => {
    expect(t.title.length).toBeGreaterThan(0);
    expect(t.job.length).toBeGreaterThan(0);
    expect(t.job).not.toContain("\n");
    expect(Pattern.safeParse(t.pattern).success).toBe(true);
    expect(t.whenToUse.length).toBeGreaterThan(0);
    expect(t.whenNotToUse.length).toBeGreaterThan(0);
    expect(t.examples.length).toBeGreaterThanOrEqual(2);
    expect(t.examples.length).toBeLessThanOrEqual(3);
  });

  it("parses with the strict spec schema, as plain JSON", () => {
    const parsed = parseSpec(JSON.parse(JSON.stringify(t.spec)));
    expect(parsed.ok ? [] : parsed.details).toEqual([]);
  });

  it("lints with no errors against its pinned model profile", () => {
    const profile = SEED_MODEL_PROFILES.find((p) => p.id === t.spec.model) ?? null;
    expect(profile?.kind).toBe("versioned");
    const findings = lint(t.spec, profile);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const warnings = findings.filter((f) => f.severity === "warning").map((f) => f.rule);
    expect(warnings.sort()).toEqual([...(EXPECTED_WARNINGS[t.id] ?? [])].sort());
  });

  it("sends outages to review", () => {
    expect(onUnavailableOf(t.spec)).toBe("review");
  });

  it("has one borderline case per question, and no others", () => {
    const qids = specQuestions(t.spec).map((q) => q.id).sort();
    expect(Object.keys(t.borderline).sort()).toEqual(qids);
    for (const b of Object.values(t.borderline)) expect(b.why.length).toBeGreaterThan(0);
  });

  it("ships states that are valid for the spec's input schema", () => {
    for (const { label, state } of statesOf(t)) {
      expect(validateJsonSchema(t.spec.input.schema, state), label).toEqual([]);
    }
  });
});

describe("writing rules in template text", () => {
  const banned = /\b(leverage|utilize|delve|seamless|robust|comprehensive|cutting-edge|streamline|empower|unlock|furthermore|moreover)\b/i;

  it.each(each)("%s has no em dashes, emojis or filler words", (_id, t) => {
    const text = JSON.stringify(t);
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(banned);
  });
});

describe("local fixture-mode runs through the CLI", () => {
  let dir = "";
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bandwise-templates-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network access in local mode");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each(each)("%s returns a RunResult for every example and borderline state", async (id, t) => {
    const specPath = join(dir, `${id}.spec.json`);
    writeFileSync(specPath, JSON.stringify(t.spec));
    for (const [i, { label, state }] of statesOf(t).entries()) {
      const statePath = join(dir, `${id}.${i}.state.json`);
      writeFileSync(statePath, JSON.stringify(state));
      const out = await main(["run", "--local", specPath, statePath, "--json"]);
      const parsed = RunResult.safeParse(JSON.parse(out.stdout));
      expect(parsed.success, `${label}: ${out.stderr}`).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.status, label).toBe("ok");
      expect(out.exitCode, label).toBe(0);
      const qids = specQuestions(t.spec).map((q) => q.id);
      for (const qid of qids) expect(parsed.data.decisions[qid], `${label}: ${qid}`).toBeDefined();
    }
    expect(fetchCalls).toBe(0);
  });
});
