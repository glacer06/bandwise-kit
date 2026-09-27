import { describe, expect, it } from "vitest";

import {
  AppLanguage,
  BindingRuntime,
  DEFAULT_DEPLOY_TARGET,
  DeployTarget,
  Opportunity,
  OpportunityRecord,
  Pattern,
} from "./deploy.js";

const APP_ID = "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c0d";
const SET_ID = "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c0e";

const opportunity = {
  appId: APP_ID,
  source: "agent",
  location: { file: "src/inbox/triage.ts", lines: "120-148" },
  currentApproach: "regex",
  decisionSummary: "decide whether an inbound email needs a reply today",
  primitiveGuess: "noul",
  pattern: "confidence_routing",
  tenSecondFit: true,
  status: "proposed",
  setId: null,
} as const;

describe("DeployTarget", () => {
  it("has three targets and managed is the default", () => {
    expect(DeployTarget.options).toEqual(["managed", "managed_typed", "standalone"]);
    expect(DEFAULT_DEPLOY_TARGET).toBe("managed");
    expect(DeployTarget.safeParse("hosted").success).toBe(false);
  });

  it("has the app language and binding runtime unions", () => {
    expect(AppLanguage.options).toEqual(["ts", "py", "other"]);
    expect(BindingRuntime.options).toEqual(["ts", "py", "http"]);
  });
});

describe("Opportunity", () => {
  it("parses a proposed opportunity from the agent path", () => {
    expect(Opportunity.parse(opportunity)).toEqual(opportunity);
  });

  it("parses a console opportunity with no location", () => {
    expect(Opportunity.safeParse({ ...opportunity, source: "console", location: null }).success).toBe(true);
  });

  it("is strict: extra fields such as source code fail", () => {
    expect(Opportunity.safeParse({ ...opportunity, snippet: "if (/urgent/.test(s)) {}" }).success).toBe(false);
    expect(
      Opportunity.safeParse({ ...opportunity, location: { file: "a.ts", lines: "1-2", contents: "x" } }).success,
    ).toBe(false);
  });

  it("accepts every pattern, including keep_in_code", () => {
    for (const pattern of Pattern.options) {
      expect(Opportunity.safeParse({ ...opportunity, pattern }).success).toBe(true);
    }
    expect(Opportunity.safeParse({ ...opportunity, pattern: "canary" }).success).toBe(false);
  });

  it("takes only v1 question types as the primitive guess", () => {
    expect(Opportunity.safeParse({ ...opportunity, primitiveGuess: "text" }).success).toBe(false);
  });

  it("requires a linked set once built", () => {
    const r = Opportunity.safeParse({ ...opportunity, status: "built" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["setId"]);
    expect(Opportunity.safeParse({ ...opportunity, status: "built", setId: SET_ID }).success).toBe(true);
  });

  it("rejects an empty summary and an unknown status or approach", () => {
    expect(Opportunity.safeParse({ ...opportunity, decisionSummary: "" }).success).toBe(false);
    expect(Opportunity.safeParse({ ...opportunity, status: "deployed" }).success).toBe(false);
    expect(Opportunity.safeParse({ ...opportunity, currentApproach: "ml_model" }).success).toBe(false);
  });
});

describe("OpportunityRecord", () => {
  const record = {
    ...opportunity,
    id: "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c0f",
    orgId: "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c11",
    createdByUserId: "0190a3c2-6f1e-7a3b-8c4d-5e6f7a8b9c10",
    createdByTokenId: null,
    createdAt: "2026-09-26T14:02:00Z",
  };

  it("adds the server fields", () => {
    expect(OpportunityRecord.parse(record)).toEqual(record);
    expect(OpportunityRecord.safeParse({ ...record, createdAt: "yesterday" }).success).toBe(false);
  });

  it("is a row schema: needs orgId and strips a column added later", () => {
    const { orgId: _orgId, ...withoutOrg } = record;
    expect(OpportunityRecord.safeParse(withoutOrg).success).toBe(false);
    expect(OpportunityRecord.parse({ ...record, updatedAt: "2026-09-27T00:00:00Z" })).toEqual(record);
  });

  it("keeps the built rule", () => {
    expect(OpportunityRecord.safeParse({ ...record, status: "built" }).success).toBe(false);
  });
});
