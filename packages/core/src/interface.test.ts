import { describe, expect, it } from "vitest";
import { SetInterface } from "./contracts/spec.js";
import { diffInterface, interfaceHash, interfaceOf } from "./interface.js";
import { exampleSpec } from "./test/harness.js";

describe("interfaceOf", () => {
  it("lists questions with options and levels, composites and route outputs", () => {
    const iface = interfaceOf(exampleSpec());
    expect(SetInterface.parse(iface)).toEqual(iface);
    expect(iface.questions).toEqual([
      { id: "real_person", type: "noul" },
      { id: "someone_waiting", type: "noul" },
      { id: "cost_of_ignoring", type: "score", levels: 4 },
      { id: "category", type: "choice", options: ["work_request", "scheduling", "personal", "newsletter", "transactional", "none_of_these"] },
      { id: "work_type", type: "choice", options: ["decision", "information", "review", "none_of_these"] },
    ]);
    expect(iface.composites).toEqual(["urgency"]);
    expect(iface.routeOutputs).toEqual(["urgent", "read_later", "normal"]);
  });

  it("dedupes route outputs and hashes stably", () => {
    const spec = { ...exampleSpec(), routes: [{ when: { check: "a" }, output: "x" }, { when: { check: "b" }, output: "x" }], defaultRoute: "x" };
    expect(interfaceOf(spec).routeOutputs).toEqual(["x"]);
    expect(interfaceHash(interfaceOf(exampleSpec()))).toBe(interfaceHash(interfaceOf(exampleSpec())));
    const noRoutes = { ...exampleSpec() };
    delete noRoutes.routes;
    delete noRoutes.defaultRoute;
    delete noRoutes.composites;
    expect(interfaceOf(noRoutes)).toMatchObject({ routeOutputs: [], composites: [] });
  });
});

const base: SetInterface = {
  inputSchema: {
    type: "object",
    required: ["email"],
    properties: { email: { type: "object", properties: { subject: { type: "string" } } }, tag: { type: "string", enum: ["a", "b"] } },
  },
  questions: [
    { id: "category", type: "choice", options: ["work", "newsletter", "none"] },
    { id: "urgency", type: "score", levels: 4 },
    { id: "spam", type: "noul" },
  ],
  composites: ["priority"],
  routeOutputs: ["urgent", "normal"],
};

describe("diffInterface", () => {
  it("is empty for the same interface", () => {
    expect(diffInterface(base, base)).toEqual({ breaking: [], additive: [] });
  });

  it("the documented example", () => {
    const next = {
      ...base,
      questions: [
        { id: "category", type: "choice" as const, options: ["work", "none"] },
        { id: "urgency", type: "score" as const, levels: 4 },
        { id: "spam", type: "noul" as const },
        { id: "work_type", type: "choice" as const, options: ["decision"] },
      ],
    };
    expect(diffInterface(base, next)).toEqual({ breaking: ["choice option removed: category.newsletter"], additive: ["question added: work_type"] });
  });

  it("breaking: removals, type and level changes", () => {
    const next: SetInterface = {
      ...base,
      questions: [
        { id: "category", type: "noul" },
        { id: "urgency", type: "score", levels: 5 },
      ],
      composites: [],
      routeOutputs: ["normal"],
    };
    expect(diffInterface(base, next).breaking).toEqual([
      "question type changed: category (choice to noul)",
      "score levels changed: urgency (4 to 5)",
      "question removed: spam",
      "composite removed: priority",
      "route output removed: urgent",
    ]);
  });

  it("additive: new options, composites and route outputs", () => {
    const next: SetInterface = {
      ...base,
      questions: [{ id: "category", type: "choice", options: ["work", "newsletter", "none", "personal"] }, ...base.questions.slice(1)],
      composites: ["priority", "risk"],
      routeOutputs: ["urgent", "normal", "later"],
    };
    expect(diffInterface(base, next)).toEqual({
      breaking: [],
      additive: ["choice option added: category.personal", "composite added: risk", "route output added: later"],
    });
  });

  it("input schema: narrowing is breaking, widening is additive", () => {
    const narrowed: SetInterface = {
      ...base,
      inputSchema: {
        type: "object",
        required: ["email", "tag"],
        additionalProperties: false,
        properties: { email: { type: "string" }, tag: { type: "string", enum: ["a"] } },
      },
    };
    expect(diffInterface(base, narrowed).breaking).toEqual([
      "input field now required: input.tag",
      "input type narrowed: input.email",
      "input values narrowed: input.tag",
      "input no longer accepts extra fields: input",
    ]);
    const widened: SetInterface = {
      ...base,
      inputSchema: {
        type: ["object", "string"],
        properties: { email: { type: "object" }, tag: { type: "string" }, extra: { type: "number" }, list: { type: "array", items: { type: "integer" } } },
      },
    };
    expect(diffInterface(base, widened)).toEqual({
      breaking: [],
      additive: ["input type widened: input", "input field now optional: input.email", "input field added: input.extra", "input field added: input.list"],
    });
  });

  it("removing a property is breaking only when extra fields are not allowed", () => {
    const strict: SetInterface = { ...base, inputSchema: { type: "object", additionalProperties: false, properties: { email: {}, tag: {} } } };
    const dropped: SetInterface = { ...base, inputSchema: { type: "object", additionalProperties: false, properties: { email: {} } } };
    expect(diffInterface(strict, dropped).breaking).toEqual(["input field removed: input.tag"]);
  });

  it("integer to number widens; array items are compared", () => {
    const a: SetInterface = { ...base, inputSchema: { type: "array", items: { type: "integer" } } };
    const b: SetInterface = { ...base, inputSchema: { type: "array", items: { type: "number" } } };
    expect(diffInterface(a, b)).toEqual({ breaking: [], additive: ["input type widened: input[]"] });
    expect(diffInterface(b, a).breaking).toEqual(["input type narrowed: input[]"]);
    const untyped: SetInterface = { ...base, inputSchema: {} };
    expect(diffInterface(untyped, a).breaking).toEqual(["input type narrowed: input", "input type narrowed: input[]"]);
    expect(diffInterface({ ...base, inputSchema: { enum: [1] } }, { ...base, inputSchema: { enum: [1, 2] } })).toEqual({ breaking: [], additive: [] });
  });
});
