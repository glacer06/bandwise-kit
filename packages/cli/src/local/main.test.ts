import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunResult } from "@bandwise/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USAGE, main, parseArgs } from "../main.js";
import { localResolvedModel } from "./ports.js";

const at = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const DEMO_SPEC = at("../../../examples/email-triage.spec.json");
const DEMO_STATE = at("../../../examples/email-triage.state.json");
const TWO_STAGE_SPEC = at("../../system-one-client/fixtures/specs/two-stage.json");

describe("parseArgs", () => {
  it.each([
    [[], { kind: "help" }],
    [["--help"], { kind: "help" }],
    [["run", "--local", "s.json", "t.json"], { kind: "run-local", specPath: "s.json", statePath: "t.json", json: false }],
    [
      ["run", "s.json", "--local", "t.json", "--json", "--provider", "openrouter", "--rollout", "shadow", "--channel", "staging"],
      { kind: "run-local", specPath: "s.json", statePath: "t.json", json: true, provider: "openrouter", rollout: "shadow", channel: "staging" },
    ],
  ])("%j", (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([
    [["deploy"], "unknown command"],
    [["publish"], "needs a set"],
    [["run", "slug"], "needs --local"],
    [["run", "--local", "s.json"], "a spec file and a state file"],
    [["run", "--local", "a", "b", "--provider", "cloudflare"], "--provider must be"],
    [["run", "--local", "a", "b", "--rollout"], "--rollout must be"],
    [["run", "--local", "a", "b", "--channel", "draft"], "--channel must be"],
    [["run", "--local", "a", "b", "--verbose"], "unknown option"],
  ])("%j is an error", (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.kind).toBe("error");
    expect(parsed.kind === "error" && parsed.message).toContain(message);
  });
});

describe("bandwise run --local", () => {
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  const realKey = process.env["TYPESAFE_API_KEY"];

  beforeEach(() => {
    fetchCalls = 0;
    // No network: any fetch fails the test.
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network access in local mode");
    }) as typeof fetch;
    delete process.env["TYPESAFE_API_KEY"];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey !== undefined) process.env["TYPESAFE_API_KEY"] = realKey;
  });

  it("prints usage for --help and exits 1 on a bad command", async () => {
    expect(await main(["--help"])).toEqual({ exitCode: 0, stdout: USAGE, stderr: "" });
    const bad = await main(["deploy"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unknown command");
  });

  it("runs the demo spec on recorded fixtures with no network and no key", async () => {
    const out = await main(["run", "--local", DEMO_SPEC, DEMO_STATE]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("route urgent");
    expect(out.stdout).toContain("answers from recorded fixtures (1 call)");
    expect(out.stdout).toContain("model jev-1.13.0 answered by jev-1.13.0");
    expect(out.stdout).not.toContain("lint");
    expect(fetchCalls).toBe(0);
  });

  it("--json prints the standard RunResult envelope", async () => {
    const out = await main(["run", "--local", DEMO_SPEC, DEMO_STATE, "--json"]);
    expect(out.exitCode).toBe(0);
    const result = RunResult.parse(JSON.parse(out.stdout));
    expect(result).toMatchObject({ status: "ok", route: "urgent", overallAction: "auto", runBand: "high", typesafeRequestId: "req_fx_email_triage_demo" });
    expect(result.cost.systemOneCostUsd).toBe(0.000038);
    expect(result.cost.savingsUsd).toBeGreaterThan(0);
    expect(out.stderr).toBe("");
  });

  it("shadow rollout suppresses savings", async () => {
    const out = await main(["run", "--local", DEMO_SPEC, DEMO_STATE, "--json", "--rollout", "shadow"]);
    const result = RunResult.parse(JSON.parse(out.stdout));
    expect(result.cost.savingsSuppressed).toBe("shadow");
    expect(result.overallAction).toBe("fallback");
  });

  it("a request no fixture covers gets synthetic answers, and the output says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandwise-local-"));
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ ticket: "The export button does nothing when I click it." }));
    const out = await main(["run", "--local", TWO_STAGE_SPEC, state]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("synthetic answers. They are not model output.");
    const json = await main(["run", "--local", TWO_STAGE_SPEC, state, "--json"]);
    expect(json.stderr).toContain("synthetic");
    expect(RunResult.parse(JSON.parse(json.stdout)).status).toBe("ok");
    expect(fetchCalls).toBe(0);
  });

  it("runs on the OpenRouter route with its model ids", async () => {
    const out = await main(["run", "--local", DEMO_SPEC, DEMO_STATE, "--json", "--provider", "openrouter"]);
    const result = RunResult.parse(JSON.parse(out.stdout));
    expect(result.modelResolved).toBe("typesafe/jev-1.13-20260917");
    expect(result.stages[0]?.calls[0]?.provider).toBe("openrouter");
  });

  it("reports bad files and invalid specs with exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandwise-local-"));
    const notJson = join(dir, "bad.json");
    writeFileSync(notJson, "{ nope");
    const badSpec = join(dir, "spec.json");
    writeFileSync(badSpec, JSON.stringify({ schemaVersion: 1, rollout: "full" }));

    const missing = await main(["run", "--local", join(dir, "missing.json"), DEMO_STATE]);
    expect(missing).toMatchObject({ exitCode: 1 });
    expect(missing.stderr).toContain("cannot read the spec file");
    expect((await main(["run", "--local", DEMO_SPEC, notJson])).stderr).toContain("not valid JSON");
    const invalid = await main(["run", "--local", badSpec, DEMO_STATE, "--json"]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).error.details.map((d: { rule: string }) => d.rule)).toContain("spec.unknown_key");
  });

  it("an invalid state is refused before any call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandwise-local-"));
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ email: { from: 1 } }));
    const out = await main(["run", "--local", DEMO_SPEC, state]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("error invalid_state");
  });

  it("shows lint findings and failed runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandwise-local-"));
    const spec = join(dir, "spec.json");
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ ticket: "hi" }));
    writeFileSync(
      spec,
      JSON.stringify({
        schemaVersion: 1,
        model: "jev-latest",
        input: { schema: { type: "object", properties: { ticket: { type: "string" } } } },
        stages: [{ id: "main", questions: { spam: { type: "noul", instructions: "Spam?", meta: { label: "Spam" } } } }],
        policies: { spam: { type: "noul", gating: true, noul: { trueAt: 0.85, falseAt: 0.15, reviewMargin: 0.1 }, actions: { high: { kind: "auto" }, medium: { kind: "review" }, low: { kind: "review" } } } },
      }),
    );
    const out = await main(["run", "--local", spec, state]);
    expect(out.stdout).toContain("warning instructions.too_short");
    expect(out.stdout).toContain("model jev-latest answered by jev-1.13.0");
    const json = await main(["run", "--local", spec, state, "--json"]);
    expect(json.stderr).toContain("instructions.too_short");
  });

  it("maps local model ids for synthetic answers", () => {
    expect(localResolvedModel("jev-latest", "typesafe")).toBe("jev-1.13.0");
    expect(localResolvedModel("jev-1.13.0", "typesafe")).toBe("jev-1.13.0");
    expect(localResolvedModel("typesafe/jev-1.13", "openrouter")).toBe("typesafe/jev-1.13-20260917");
    expect(localResolvedModel("~typesafe/jev-latest", "openrouter")).toBe("typesafe/jev-1.13-20260917");
    expect(localResolvedModel("other/model", "openrouter")).toBe("other/model");
    // Vercel answers with the id it was sent; no OpenRouter build leaks across providers.
    expect(localResolvedModel("typesafe-ai/jev", "vercel")).toBe("typesafe-ai/jev");
  });
});
