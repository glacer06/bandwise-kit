import { describe, expect, it } from "vitest";

import { SpecChange, SpecDiff, comparePointers } from "./spec-diff.js";

const sample = {
  from: "email-triage@7",
  to: "email-triage@draft",
  changes: [
    { path: "/model", op: "replace", before: "jev-latest", after: "jev-1.13.0" },
    { path: "/policies/urgency/thresholds/high", op: "replace", before: 0.75, after: 0.8 },
    { path: "/stages/1/questions/work_type", op: "add", after: { type: "choice" } },
    { path: "/stages/1/questions/work_type/meta", op: "remove", before: null },
  ],
  interface: { breaking: [], additive: ["question added: work_type"] },
};

describe("SpecDiff", () => {
  it("parses the documented shape and round-trips", () => {
    const parsed = SpecDiff.parse(sample);
    expect(parsed).toEqual(sample);
    expect(SpecDiff.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("accepts an empty diff", () => {
    expect(SpecDiff.safeParse({ ...sample, changes: [] }).success).toBe(true);
  });

  it("requires changes sorted by path", () => {
    const unsorted = { ...sample, changes: [sample.changes[1], sample.changes[0]] };
    const result = SpecDiff.safeParse(unsorted);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["changes", 1, "path"]);
  });

  it("requires the interface diff", () => {
    const { interface: _omit, ...rest } = sample;
    expect(SpecDiff.safeParse(rest).success).toBe(false);
  });

  it("orders pointers by code unit", () => {
    expect(comparePointers("/a", "/b")).toBeLessThan(0);
    expect(comparePointers("/b", "/a")).toBeGreaterThan(0);
    expect(comparePointers("/a", "/a")).toBe(0);
  });
});

describe("SpecChange", () => {
  it("rejects before on an add and after on a remove", () => {
    expect(SpecChange.safeParse({ path: "/x", op: "add", before: 1, after: 2 }).success).toBe(false);
    expect(SpecChange.safeParse({ path: "/x", op: "remove", before: 1, after: 2 }).success).toBe(false);
  });

  it("needs the value each op carries", () => {
    expect(SpecChange.safeParse({ path: "/x", op: "add" }).success).toBe(false);
    expect(SpecChange.safeParse({ path: "/x", op: "remove" }).success).toBe(false);
    expect(SpecChange.safeParse({ path: "/x", op: "replace", before: 1 }).success).toBe(false);
    expect(SpecChange.safeParse({ path: "/x", op: "replace", before: null, after: 1 }).success).toBe(true);
  });

  it("accepts the root pointer and escaped segments, rejects other paths", () => {
    expect(SpecChange.safeParse({ path: "", op: "replace", before: {}, after: {} }).success).toBe(true);
    expect(SpecChange.safeParse({ path: "/a~1b/c~0d", op: "add", after: 1 }).success).toBe(true);
    expect(SpecChange.safeParse({ path: "model", op: "add", after: 1 }).success).toBe(false);
    expect(SpecChange.safeParse({ path: "/a~2", op: "add", after: 1 }).success).toBe(false);
  });

  it("rejects an unknown op", () => {
    expect(SpecChange.safeParse({ path: "/x", op: "move", before: 1, after: 2 }).success).toBe(false);
  });
});
