import { describe, expect, it } from "vitest";

import { redactSecrets, shapeState } from "./index.js";

describe("redaction and state shaping", () => {
  it("replaces secret-shaped text", () => {
    // Secret-shaped samples are assembled at run time, so no literal key shape sits in the source.
    const j = (...parts: string[]): string => parts.join("");
    const text = [
      `export OPENAI_API_KEY=${j("sk-", "proj-", "abcdefghijklmnopqrstuvwx")}`,
      "curl -H 'Authorization: Bearer abc.def.ghi-123456'",
      `token ${j("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123")}`,
      `aws ${j("AK", "IA", "ABCDEFGHIJKLMNOP")}`,
      j("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow\n-----END RSA ", "PRIVATE KEY-----"),
      'password: "hunter2"',
      "opaque Zx9aQ2bR7cT4dU1eV8fW3gX6hY0iJ5kL",
    ].join("\n");
    const out = redactSecrets(text);
    for (const secret of ["sk-proj-abc", "abc.def.ghi", "ghp_abc", "AKIAABC", "MIIEow", "hunter2", "Zx9aQ2bR7c"]) expect(out).not.toContain(secret);
    expect(out).toContain("OPENAI_API_KEY=[redacted]");
  });

  it("replaces short secrets in JSON fields, auth headers, CLI flags and URLs", () => {
    // Connection strings are assembled at run time, so no literal credential URL sits in the source.
    const pg = (password: string): string => ["postgres", "://app:", password, "@db:5432/app"].join("");
    const cases: Array<[string, string]> = [
      ['{"apiKey": "abc123"}', "abc123"],
      ["{'client_secret': 'tiny'}", "tiny"],
      ["api-token: zz9", "zz9"],
      ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["-H 'Proxy-Authorization: Digest a1b2'", "a1b2"],
      ["curl --api-key s3cr3t https://example.com", "s3cr3t"],
      ["tool -p hunter2 --password hunter3", "hunter3"],
      [`psql ${pg("hunter2")}`, "hunter2"],
      ["https://user:pa55@example.com/x", "pa55"],
    ];
    for (const [text, secret] of cases) expect(redactSecrets(text), text).not.toContain(secret);
    expect(redactSecrets("curl --api-key s3cr3t https://example.com")).toBe("curl --api-key [redacted] https://example.com");
    expect(redactSecrets(`psql ${pg("hunter2")}`)).toBe(`psql ${pg("[redacted]")}`);
  });

  it("keeps commit ids and ordinary words", () => {
    const sha = "9b8be065afb60ec56bb262b7488f9dc7de853925";
    expect(redactSecrets(`git show ${sha}`)).toBe(`git show ${sha}`);
    expect(redactSecrets("pnpm --filter @bandwise/cli test")).toBe("pnpm --filter @bandwise/cli test");
  });

  it("sends only the fields the schema names, cut to maxLength", () => {
    const schema = { type: "object", properties: { prompt: { type: "string", maxLength: 5 }, n: { type: "number" }, gone: { type: "string" } } };
    expect(shapeState({ prompt: "abcdefgh", n: 3, secret: "x", gone: "y" }, schema, ["gone"])).toEqual({ prompt: "abcde", n: 3 });
  });
});

describe("redaction cost and the 2026-10-01 security review", () => {
  // Fields are cut to their schema maxLength (8000 at most today) before redaction, so 16 KB is
  // twice the largest real input. The bound is loose for shared CI runners with coverage on. The
  // old patterns took tens of seconds here, and grew with the cube of the length.
  const units = ["key-", "--key", "token_", "secret", "a://b", "Bearer ", ["-----BEGIN A ", "PRIVATE KEY-----"].join(""), ["sk-", "proj-"].join("")];
  const timeOf = (text: string): number => {
    const started = performance.now();
    redactSecrets(text);
    return performance.now() - started;
  };

  it("stays fast on input built to make the name patterns backtrack", () => {
    for (const unit of units) {
      const text = unit.repeat(Math.ceil((16 * 1024) / unit.length));
      expect(timeOf(text), unit).toBeLessThan(1500);
    }
  });

  it("grows about linearly with input size, not with its square or cube", () => {
    for (const unit of ["key-", "--key"]) {
      const at = (kb: number) => unit.repeat(Math.ceil((kb * 1024) / unit.length));
      timeOf(at(4));
      const small = Math.max(timeOf(at(8)), 1);
      const large = timeOf(at(32));
      // Four times the input: linear is about 4x, quadratic 16x, cubic 64x.
      expect(large / small, unit).toBeLessThan(10);
    }
  });

  it("cuts a field to maxLength before redacting it", () => {
    const schema = { type: "object", properties: { last_reply: { type: "string", maxLength: 8000 } } };
    const started = performance.now();
    const out = shapeState({ last_reply: "key-".repeat(16_000) }, schema);
    expect(performance.now() - started).toBeLessThan(1500);
    expect((out["last_reply"] as string).length).toBeLessThanOrEqual(8000);
  });

  it("redacts DB_PASS assignments, curl -u passwords and GitLab tokens, and keeps --passWithNoTests", () => {
    const j = (...parts: string[]): string => parts.join("");
    expect(redactSecrets("DB_PASS=Tr0ub4dor")).toBe("DB_PASS=[redacted]");
    expect(redactSecrets("curl -u admin:S3cretPass https://x.example")).toBe("curl -u admin:[redacted] https://x.example");
    expect(redactSecrets(j("glpat", "-", "abcdefghijklmnopqrstuvwx"))).toBe("[redacted]");
    expect(redactSecrets("pnpm vitest --passWithNoTests src/a.ts")).toBe("pnpm vitest --passWithNoTests src/a.ts");
  });
});

describe("unterminated quoted secrets", () => {
  const secret = "aZ".repeat(4500);
  const shapes = [
    (s: string) => `{"password":"${s}"}`,
    (s: string) => `{'client_secret': '${s}'}`,
    (s: string) => `DB_PASS="${s}"`,
    (s: string) => `tool --api-key '${s}' --next`,
    (s: string) => `api_token = "${s}"`,
  ];

  it("redacts a quoted value that the length cut leaves open, in both quote styles", () => {
    const schema = { type: "object", properties: { last_reply: { type: "string", maxLength: 8000 } } };
    for (const shape of shapes) {
      const out = shapeState({ last_reply: shape(secret) }, schema)["last_reply"] as string;
      expect(out, shape("…")).toContain("[redacted]");
      expect(out, shape("…")).not.toContain("aZaZ");
    }
  });

  it("redacts at every cut point through the value, not only one", () => {
    const text = `{"password":"Tr0ub4dor-and-more-Zq9"} done`;
    for (let cut = text.indexOf("Tr0") + 1; cut <= text.length; cut++) {
      const schema = { type: "object", properties: { f: { type: "string", maxLength: cut } } };
      const out = shapeState({ f: text }, schema)["f"] as string;
      expect(out, `cut ${cut}`).not.toMatch(/Tr0|ub4|dor|Zq9/);
    }
  });

  it("redacts a value that arrives already cut, within the limit", () => {
    expect(redactSecrets(`{"password":"hunter2-still-going`)).not.toContain("hunter2");
    expect(redactSecrets(`password: 'hunter2 still going`)).not.toContain("hunter2");
  });
});
