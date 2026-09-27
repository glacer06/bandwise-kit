import { describe, expect, it } from "vitest";
import { canonicalJson, hashJson } from "./canonical-json.js";
import { schemaAtPath, validateJsonSchema } from "./json-schema.js";
import { edge, roundHalfUp } from "./numbers.js";
import { sha256Hex, utf8Bytes, utf8Length } from "./sha256.js";
import { backtickPaths, isStatePath, parseStatePath, resolveStatePath, stringsIn } from "./state-path.js";
import { estimateTokens } from "./tokens.js";

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    ["é中\u{1F600}", "aabae3418ff6346303d27c710ec789e76a3d57634026fc011ac96be24144615a"],
  ])("%j", (text, hex) => {
    expect(sha256Hex(text)).toBe(hex);
  });

  it("encodes multi-byte text as UTF-8", () => {
    const text = "é中\u{1F600}";
    expect(utf8Bytes(text)).toEqual([0xc3, 0xa9, 0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98, 0x80]);
    expect(utf8Length(text)).toBe(9);
  });

  it("hashes a million a's", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });
});

describe("canonical JSON", () => {
  it("sorts keys at every level and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });
});

describe("numbers", () => {
  it("round half up and threshold edges", () => {
    expect(roundHalfUp(13.356)).toBe(13);
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(-0.5)).toBe(0);
    expect(edge(0.85 - 0.1)).toBe(0.75);
  });
});

describe("state paths", () => {
  it("parses, resolves and finds backtick paths", () => {
    expect(isStatePath("items[0].sku")).toBe(true);
    expect(isStatePath("a..b")).toBe(false);
    expect(parseStatePath("a.b[2]")).toEqual([{ key: "a" }, { key: "b" }, { index: 2 }]);
    expect(parseStatePath("not a path")).toBeNull();
    const state = { items: [{ sku: "X1" }], n: null };
    expect(resolveStatePath(state, "items[0].sku")).toBe("X1");
    expect(resolveStatePath(state, "items[1].sku")).toBeUndefined();
    expect(resolveStatePath(state, "items.sku")).toBeUndefined();
    expect(resolveStatePath(state, "n.x")).toBeUndefined();
    expect(resolveStatePath(state, "n")).toBeNull();
    expect(resolveStatePath(state, "missing")).toBeUndefined();
    expect(resolveStatePath(state, "bad path")).toBeUndefined();
    expect(backtickPaths("Is `email.subject` like `a b` or `items[0]`?")).toEqual(["email.subject", "items[0]"]);
    expect(stringsIn({ a: ["x", { b: "y" }], c: 1, d: null })).toEqual(["x", "y"]);
  });
});

describe("token estimates", () => {
  it("are UTF-8 bytes over 4, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens({ a: 1 })).toBe(2); // {"a":1} is 7 bytes
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    required: ["email"],
    additionalProperties: false,
    properties: {
      email: {
        type: "object",
        required: ["from"],
        properties: { from: { type: "string", minLength: 3, maxLength: 50, pattern: "@" }, tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } },
      },
      score: { type: "number", minimum: 0, maximum: 1 },
      kind: { enum: ["a", "b"] },
      fixed: { const: 1 },
      either: { anyOf: [{ type: "string" }, { type: "integer" }] },
      one: { oneOf: [{ type: "string" }, { type: "string", maxLength: 1 }] },
      both: { allOf: [{ type: "string" }, { minLength: 2 }] },
      never: { not: { type: "string" } },
      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      nothing: false,
    },
  };

  it("accepts a valid value", () => {
    expect(validateJsonSchema(schema, { email: { from: "a@b.c", tags: ["x"] }, score: 0.5, kind: "a", fixed: 1, either: 3, one: "ab", both: "ok", never: 1, tuple: ["a", 1] })).toEqual([]);
    expect(validateJsonSchema(true, 1)).toEqual([]);
    expect(validateJsonSchema(null, 1)).toEqual([]);
  });

  it("reports each problem with a JSON Pointer", () => {
    const issues = validateJsonSchema(schema, {
      email: { from: "x", tags: [] },
      score: 2,
      kind: "c",
      fixed: 2,
      either: 1.5,
      one: "a",
      both: "a",
      never: "s",
      tuple: [1, "x"],
      nothing: 1,
      extra: true,
    });
    expect(issues.map((i) => i.path)).toEqual([
      "/email/from",
      "/email/from",
      "/email/tags",
      "/score",
      "/kind",
      "/fixed",
      "/either",
      "/one",
      "/both",
      "/never",
      "/tuple/0",
      "/tuple/1",
      "/nothing",
      "/extra",
    ]);
    expect(validateJsonSchema(schema, {})).toEqual([{ path: "/email", message: "is required" }]);
    expect(validateJsonSchema(schema, "x")[0]?.message).toBe("expected object, got string");
    expect(validateJsonSchema({ type: ["string", "null"] }, null)).toEqual([]);
    expect(validateJsonSchema({ maxLength: 1, maximum: 1, maxItems: 1 }, "ab").length).toBe(1);
    expect(validateJsonSchema({ minimum: 5 }, 1).length).toBe(1);
    expect(validateJsonSchema({ maxItems: 1 }, [1, 2]).length).toBe(1);
  });

  it("finds the sub-schema a path points at", () => {
    const seg = (p: string) => parseStatePath(p) ?? [];
    expect(schemaAtPath(schema, seg("email.from"))).toMatchObject({ type: "string" });
    expect(schemaAtPath(schema, seg("email.cc"))).toBeNull();
    expect(schemaAtPath({ type: "object" }, seg("anything"))).toEqual({});
    expect(schemaAtPath(schema, seg("extra"))).toBeNull();
    expect(schemaAtPath(schema, seg("email.from.x"))).toBeNull();
    expect(schemaAtPath(schema, seg("email.tags[0]"))).toEqual({ type: "string" });
    expect(schemaAtPath(schema, seg("tuple[1]"))).toEqual({ type: "number" });
    expect(schemaAtPath(schema, seg("tuple[5]"))).toEqual({});
    expect(schemaAtPath(schema, seg("score[0]"))).toBeNull();
    expect(schemaAtPath({ type: "object", properties: {}, additionalProperties: { type: "number" } }, seg("x"))).toEqual({ type: "number" });
    expect(schemaAtPath({ type: ["object", "null"] }, seg("x"))).toEqual({});
    expect(schemaAtPath({ type: "object", properties: { x: { type: ["array"] } } }, seg("x[0]"))).toEqual({});
    expect(schemaAtPath(true, seg("x.y"))).toBe(true);
    expect(schemaAtPath(null, seg("x"))).toBeNull();
  });
});
