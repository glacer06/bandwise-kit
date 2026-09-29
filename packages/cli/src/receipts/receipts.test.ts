import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { type Receipt, appendReceipt, buildReport, defaultReceiptsPath, parseSince, readReceipts, specHash } from "./index.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    v: 1,
    at: "2026-09-28T11:00:00.000Z",
    set: "done-check",
    specHash: "fnv1a64:0000000000000000",
    source: "Stop",
    provider: "typesafe",
    rollout: "shadow",
    status: "ok",
    modelRequested: "jev-1.13.0",
    modelResolved: "jev-1.13.0",
    route: "stop",
    runBand: "high",
    overallAction: "fallback",
    decisions: { turn_outcome: { value: "finished", band: "high", action: "auto", effectiveAction: "fallback", relevant: true } },
    acted: false,
    systemOneCostUsd: 0.00002,
    counterfactualLlmCostUsd: 0.0005,
    comparatorModel: "claude-haiku-4-5",
    savingsUsd: 0,
    savingsSuppressed: "shadow",
    latencyMs: 300,
    ...over,
  };
}

describe("receipts file", () => {
  it("appends lines and reads them back, skipping lines it cannot read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bandwise-r-")), "deep", "r.jsonl");
    appendReceipt(path, receipt());
    appendReceipt(path, receipt({ set: "model-tier" }));
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"v":99}\n`);
    const { receipts, skipped } = readReceipts(path);
    expect(receipts.map((r) => r.set)).toEqual(["done-check", "model-tier"]);
    expect(skipped).toBe(2);
    expect(readReceipts(join(path, "missing"))).toEqual({ receipts: [], skipped: 0 });
  });

  it("defaults to ~/.bandwise/receipts.jsonl", () => {
    expect(defaultReceiptsPath("/home/nick")).toBe("/home/nick/.bandwise/receipts.jsonl");
  });

  it("hashes spec text stably", () => {
    expect(specHash("{}")).toBe(specHash("{}"));
    expect(specHash("{}")).not.toBe(specHash("{ }"));
    expect(specHash("")).toBe("fnv1a64:cbf29ce484222325");
  });
});

describe("report", () => {
  it("parses windows", () => {
    expect(parseSince("7d")).toBe(7 * 86_400_000);
    expect(parseSince("24h")).toBe(86_400_000);
    expect(parseSince("30m")).toBe(1_800_000);
    expect(parseSince("week")).toBeNull();
  });

  it("sums per set: decisions, bands, would-act, spend and estimated savings", () => {
    const rs = [
      receipt(),
      receipt({ route: "continue", overallAction: "auto", decisions: { turn_outcome: { value: "unverified", band: "medium", action: "review", effectiveAction: "fallback", relevant: true } } }),
      receipt({ status: "timeout", decisions: {}, systemOneCostUsd: null, counterfactualLlmCostUsd: 0 }),
      receipt({ set: "model-tier", at: "2026-09-10T00:00:00.000Z" }),
    ];
    const r = buildReport(rs, { now: NOW, sinceMs: parseSince("7d"), sinceText: "7d" });
    expect(r.sets).toHaveLength(1);
    const s = r.sets[0];
    expect(s).toMatchObject({ set: "done-check", runs: 3, failed: 1, decisions: 2, bands: { high: 1, medium: 1, low: 0 }, wouldAct: 1, acted: 0, rollouts: ["shadow"] });
    expect(s?.systemOneCostUsd).toBe(0.00004);
    expect(s?.counterfactualLlmCostUsd).toBe(0.001);
    expect(s?.estimatedSavingsUsd).toBe(0.00096);
    expect(r.estimated).toBe(true);
    expect(buildReport(rs, { now: NOW }).sets.map((x) => x.set)).toEqual(["done-check", "model-tier"]);
    expect(buildReport(rs, { now: NOW, set: "model-tier" }).sets.map((x) => x.set)).toEqual(["model-tier"]);
  });

  it("bandwise report prints the estimate labels, or JSON", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "bandwise-r-")), "r.jsonl");
    appendReceipt(path, receipt());
    const text = await main(["report", "--receipts", path], { now: () => NOW });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("done-check (shadow)");
    expect(text.stdout).toContain("estimated savings $0.000480 (estimate)");
    const json = await main(["report", "--receipts", path, "--json", "--since", "1h", "--set", "done-check"], { now: () => NOW });
    expect(JSON.parse(json.stdout)).toMatchObject({ estimated: true, since: "1h", sets: [{ set: "done-check", runs: 1 }] });
    const empty = await main(["report", "--receipts", join(path, "none")]);
    expect(empty.stdout).toContain("no receipts");
    expect((await main(["report", "--since", "soon"])).exitCode).toBe(1);
  });
});
