// A small JSON Schema (draft 7) validator for run state. Core is
// pure and imports only zod, so it carries the keywords specs use: type, enum, const, required,
// properties, additionalProperties, items, min/max length, items and value bounds, pattern,
// allOf, anyOf, oneOf and not. Unknown keywords are ignored, as JSON Schema says.

import { linearMatch } from "./regex.js";

/** One validation failure: a JSON Pointer into the state and a message. */
export interface SchemaIssue {
  path: string;
  message: string;
}

type Schema = Record<string, unknown> | boolean;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const pointer = (base: string, key: string | number): string =>
  `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function check(schema: Schema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (schema === true) return;
  if (schema === false) {
    issues.push({ path, message: "no value is allowed here" });
    return;
  }
  const s = schema;
  const fail = (message: string): void => {
    issues.push({ path, message });
  };

  if (s["type"] !== undefined) {
    const types = Array.isArray(s["type"]) ? (s["type"] as string[]) : [s["type"] as string];
    if (!types.some((t) => typeMatches(value, t))) {
      fail(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(s["enum"]) && !s["enum"].some((e) => jsonEqual(e, value))) fail("not one of the allowed values");
  if ("const" in s && !jsonEqual(s["const"], value)) fail("does not equal the required value");

  if (typeof value === "string") {
    const len = Array.from(value).length;
    if (typeof s["minLength"] === "number" && len < s["minLength"]) fail(`shorter than ${s["minLength"]}`);
    if (typeof s["maxLength"] === "number" && len > s["maxLength"]) fail(`longer than ${s["maxLength"]}`);
    if (typeof s["pattern"] === "string" && !linearMatch(s["pattern"], value)) fail("does not match the pattern");
  }
  if (typeof value === "number") {
    if (typeof s["minimum"] === "number" && value < s["minimum"]) fail(`below ${s["minimum"]}`);
    if (typeof s["maximum"] === "number" && value > s["maximum"]) fail(`above ${s["maximum"]}`);
  }
  if (Array.isArray(value)) {
    if (typeof s["minItems"] === "number" && value.length < s["minItems"]) fail(`fewer than ${s["minItems"]} items`);
    if (typeof s["maxItems"] === "number" && value.length > s["maxItems"]) fail(`more than ${s["maxItems"]} items`);
    const items = s["items"];
    if (Array.isArray(items)) {
      items.forEach((itemSchema, i) => {
        if (i < value.length) check(itemSchema as Schema, value[i], pointer(path, i), issues);
      });
    } else if (items !== undefined) {
      value.forEach((v, i) => check(items as Schema, v, pointer(path, i), issues));
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s["required"])) {
      for (const key of s["required"] as string[]) {
        if (!Object.hasOwn(obj, key)) issues.push({ path: pointer(path, key), message: "is required" });
      }
    }
    const props = (s["properties"] ?? {}) as Record<string, Schema>;
    for (const [key, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, key)) check(props[key] as Schema, v, pointer(path, key), issues);
      else if (s["additionalProperties"] !== undefined) {
        check(s["additionalProperties"] as Schema, v, pointer(path, key), issues);
      }
    }
  }
  if (Array.isArray(s["allOf"])) for (const sub of s["allOf"] as Schema[]) check(sub, value, path, issues);
  const passes = (sub: Schema): boolean => validateJsonSchema(sub, value).length === 0;
  if (Array.isArray(s["anyOf"]) && !(s["anyOf"] as Schema[]).some(passes)) fail("matches none of anyOf");
  if (Array.isArray(s["oneOf"]) && (s["oneOf"] as Schema[]).filter(passes).length !== 1) fail("must match exactly one of oneOf");
  if (s["not"] !== undefined && passes(s["not"] as Schema)) fail("matches a schema it must not match");
}

/** Validate `value` against `schema`. An empty list means valid. */
export function validateJsonSchema(schema: unknown, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (typeof schema === "boolean" || (schema !== null && typeof schema === "object" && !Array.isArray(schema))) {
    check(schema as Schema, value, "", issues);
  }
  return issues;
}

/**
 * The sub-schema a state path points at, or null when the path does not resolve. An object schema
 * without `properties` accepts any key (its sub-schema is `{}`); with `properties`, an unknown key
 * resolves only when `additionalProperties` is set and not false, so a typo in a lint path is caught.
 */
export function schemaAtPath(schema: unknown, segments: ReadonlyArray<{ key: string } | { index: number }>): unknown {
  let cur: unknown = schema;
  for (const seg of segments) {
    if (cur === true) return true;
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return null;
    const s = cur as Record<string, unknown>;
    const type = s["type"];
    if ("key" in seg) {
      if (type !== undefined && type !== "object" && !(Array.isArray(type) && type.includes("object"))) return null;
      const props = s["properties"] as Record<string, unknown> | undefined;
      if (props !== undefined && Object.hasOwn(props, seg.key)) cur = props[seg.key];
      else if (props === undefined && s["additionalProperties"] === undefined) cur = {};
      else if (s["additionalProperties"] !== undefined && s["additionalProperties"] !== false) {
        cur = s["additionalProperties"];
      } else return null;
    } else {
      if (type !== undefined && type !== "array" && !(Array.isArray(type) && type.includes("array"))) return null;
      const items = s["items"];
      if (Array.isArray(items)) cur = items[seg.index] ?? s["additionalItems"] ?? {};
      else cur = items ?? {};
    }
  }
  return cur;
}
