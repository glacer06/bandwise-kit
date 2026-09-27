import { describe, expect, it } from "vitest";

import {
  KNOWN_WEAKNESS_IDS,
  ModelLimits,
  ModelListItem,
  ModelProfile,
  type ModelProfileInput,
  classifyModelName,
  isPinnedProfile,
} from "./models.js";

const versioned: ModelProfileInput = {
  id: "jev-1.13.0",
  family: "jev",
  kind: "versioned",
  aliasTarget: null,
  status: "stable",
  releaseDate: null,
  retireAt: null,
  questionTypes: ["noul", "choice", "score"],
  limits: { requestTokens: 64_000, statePlusLongestQuestionTokens: 32_000, rpm: 1_200, tokensPerSec: 250_000 },
  inputModalities: ["text"],
  weaknesses: ["counting", "date_comparison"],
  supersedes: [],
  docsUrl: "https://docs.typesafe.ai/models.md",
  jaggednessUrl: "https://docs.typesafe.ai/model-jaggedness/jev-1.13.md",
  lastReviewed: "2026-09-26",
};

const alias: ModelProfileInput = {
  ...versioned,
  id: "jev-latest",
  kind: "alias",
  aliasTarget: "jev-1.13.0",
  jaggednessUrl: null,
};

describe("ModelProfile", () => {
  it("parses a versioned row and an alias row", () => {
    expect(ModelProfile.parse(versioned)).toEqual(versioned);
    expect(ModelProfile.parse(alias)).toEqual(alias);
  });

  it("is strict: an unknown key fails, including a price", () => {
    expect(ModelProfile.safeParse({ ...versioned, priceIn: 0.042 }).success).toBe(false);
  });

  it("requires supersedes, so a hand-written row cannot forget it", () => {
    const { supersedes: _omit, ...withoutSupersedes } = versioned;
    expect(ModelProfile.safeParse(withoutSupersedes).success).toBe(false);
    expect(ModelProfile.safeParse({ ...versioned, supersedes: [""] }).success).toBe(false);
  });

  it("ModelListItem is a profile plus isDefault, with the same row rules", () => {
    expect(ModelListItem.parse({ ...versioned, isDefault: true }).isDefault).toBe(true);
    expect(ModelListItem.safeParse(versioned).success).toBe(false);
    expect(ModelListItem.safeParse({ ...versioned, isDefault: false, aliasTarget: "jev-latest" }).success).toBe(false);
    expect(ModelListItem.safeParse({ ...versioned, isDefault: false, extra: 1 }).success).toBe(false);
  });

  it("allows null limits only on an unreviewed row", () => {
    const unreviewed = {
      ...alias,
      id: "foo-2.0.0",
      family: "foo",
      aliasTarget: null,
      status: "unreviewed",
      limits: null,
      questionTypes: [],
      weaknesses: [],
    };
    expect(ModelProfile.safeParse(unreviewed).success).toBe(true);
    for (const status of ["preview", "stable", "deprecated", "retired"] as const) {
      const r = ModelProfile.safeParse({ ...unreviewed, status });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["limits"]);
    }
  });

  it("rejects an aliasTarget on a versioned row", () => {
    const r = ModelProfile.safeParse({ ...versioned, aliasTarget: "jev-1.12.0" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["aliasTarget"]);
  });

  it("allows an alias whose target has not been observed yet", () => {
    expect(ModelProfile.safeParse({ ...alias, aliasTarget: null }).success).toBe(true);
  });

  it("accepts only the closed question type union, without repeats", () => {
    expect(ModelProfile.safeParse({ ...versioned, questionTypes: ["noul", "text"] }).success).toBe(false);
    expect(ModelProfile.safeParse({ ...versioned, questionTypes: ["noul", "noul"] }).success).toBe(false);
  });

  it("takes dates as YYYY-MM-DD", () => {
    expect(ModelProfile.safeParse({ ...versioned, releaseDate: "2026-09-01" }).success).toBe(true);
    expect(ModelProfile.safeParse({ ...versioned, releaseDate: "09/01/2026" }).success).toBe(false);
    expect(ModelProfile.safeParse({ ...versioned, retireAt: "2027-01-31" }).success).toBe(true);
    expect(ModelProfile.safeParse({ ...versioned, lastReviewed: "2026-09-26T00:00:00Z" }).success).toBe(false);
  });

  it("rejects an unknown kind or status", () => {
    expect(ModelProfile.safeParse({ ...versioned, kind: "partial" }).success).toBe(false);
    expect(ModelProfile.safeParse({ ...versioned, status: "beta" }).success).toBe(false);
  });

  it("keeps weaknesses open for ids a newer model documents", () => {
    expect(ModelProfile.safeParse({ ...versioned, weaknesses: ["some_new_weakness"] }).success).toBe(true);
  });
});

describe("ModelLimits", () => {
  it("requires positive integers", () => {
    expect(ModelLimits.safeParse({ requestTokens: 0, statePlusLongestQuestionTokens: 0, rpm: 1, tokensPerSec: 1 }).success).toBe(false);
    expect(ModelLimits.safeParse({ requestTokens: 1.5, statePlusLongestQuestionTokens: 1, rpm: 1, tokensPerSec: 1 }).success).toBe(false);
  });

  it("rejects a state plus longest question budget larger than the request budget", () => {
    const r = ModelLimits.safeParse({ requestTokens: 16_000, statePlusLongestQuestionTokens: 32_000, rpm: 1, tokensPerSec: 1 });
    expect(r.success).toBe(false);
  });
});

describe("pinned or moving", () => {
  const rows = [versioned, alias, { ...alias, id: "jev-preview" }].map((r) => ModelProfile.parse(r));

  it.each([
    ["jev-latest", "moving"],
    ["jev-preview", "moving"],
    ["jev", "moving"],
    ["jev-1.13", "moving"],
    ["jev-1.13.0", "pinned"],
    ["foo-2.0.0", "moving"],
  ] as const)("classifies %s as %s", (name, expected) => {
    expect(classifyModelName(name, rows)).toBe(expected);
  });

  it("never infers pinning from the shape of the name", () => {
    expect(classifyModelName("jev-1.13.0", [])).toBe("moving");
    expect(classifyModelName("custom-name", [{ id: "custom-name", kind: "versioned" }])).toBe("pinned");
  });

  it("treats a missing profile as moving", () => {
    expect(isPinnedProfile(null)).toBe(false);
    expect(isPinnedProfile(undefined)).toBe(false);
    expect(isPinnedProfile({ kind: "alias" })).toBe(false);
    expect(isPinnedProfile({ kind: "versioned" })).toBe(true);
  });
});

describe("KNOWN_WEAKNESS_IDS", () => {
  it("lists the twelve jev-1.13 weakness ids without repeats", () => {
    expect(KNOWN_WEAKNESS_IDS).toHaveLength(12);
    expect(new Set(KNOWN_WEAKNESS_IDS).size).toBe(12);
  });
});
