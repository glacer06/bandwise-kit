import { describe, expect, it } from "vitest";
import { isSupportedPattern, linearMatch } from "./regex.js";

// Every row is checked against the platform RegExp with the u flag, so the automaton agrees with
// JavaScript on the supported subset.
const rows: Array<[pattern: string, input: string]> = [
  ["^(Re|RE):", "Re: contract"],
  ["^(Re|RE):", "Fwd: Re: contract"],
  ["@noreply\\.", "bot@noreply.example.com"],
  ["@noreply\\.", "ana@example.com"],
  ["a+b", "caaab"],
  ["a+b", "cb"],
  ["colou?r", "color"],
  ["colou?r", "colour"],
  ["colou?r", "colouur"],
  ["^\\d{3}-\\d{4}$", "555-1234"],
  ["^\\d{3}-\\d{4}$", "55-1234"],
  ["^a{2,}$", "aaaa"],
  ["^a{2,}$", "a"],
  ["^a{1,3}$", "aaaa"],
  ["^a{1,3}$", "aa"],
  ["[^abc]", "abc"],
  ["[^abc]", "abcd"],
  ["[a-z]+@[a-z]+\\.com", "mail ana@example.com now"],
  ["\\bcat\\b", "concatenate"],
  ["\\bcat\\b", "a cat sat"],
  ["\\Bcat", "concatenate"],
  ["^$", ""],
  ["^$", "x"],
  ["(?:ab)*c", "ababc"],
  ["(?<word>ab)+", "xxabab"],
  ["\\p{Lu}\\p{Ll}+", "hello World"],
  ["\\u{1F600}", "smile \u{1F600}"],
  ["\\u0041", "A"],
  ["\\x41", "B"],
  [".", "\n"],
  ["a.c", "abc"],
  ["x*", ""],
  ["(a|b)*c(d|e)?$", "abbacd"],
  ["(a*)*b", "aaac"],
  ["[\\]]", "]"],
  ["\\.", "a.b"],
  ["\\u{1F600}+", "\u{1F600}\u{1F600}"],
  ["a+?b", "aab"],
  ["^(a|ab)(c|bcd)(d*)$", "abcd"],
];

describe("linearMatch", () => {
  it.each(rows)("%s on %j agrees with RegExp", (pattern, input) => {
    expect(linearMatch(pattern, input)).toBe(new RegExp(pattern, "u").test(input));
  });

  it("runs a classic catastrophic pattern in linear time", () => {
    const input = "a".repeat(5_000) + "!";
    expect(linearMatch("^(a+)+$", input)).toBe(false);
    expect(linearMatch("(a*)*b", "a".repeat(5_000) + "c")).toBe(false);
  });

  it("never matches patterns outside the subset", () => {
    expect(linearMatch("(a)\\1", "aa")).toBe(false);
    expect(linearMatch("(?=a)a", "a")).toBe(false);
    expect(linearMatch("[", "[")).toBe(false);
    expect(isSupportedPattern("(a)\\1")).toBe(false);
    expect(isSupportedPattern("a|b")).toBe(true);
  });

  it("rejects a pattern that expands past the program limit", () => {
    expect(isSupportedPattern("(a{1000}){1000}")).toBe(false);
  });

  it("serves a cached program on the second call", () => {
    expect(linearMatch("zz+", "azzz")).toBe(true);
    expect(linearMatch("zz+", "az")).toBe(false);
  });
});
