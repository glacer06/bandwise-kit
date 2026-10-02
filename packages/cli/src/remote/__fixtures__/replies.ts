// Server replies the remote tests answer with, in the exact shapes /api/v1 returns. In the
// monorepo, replies.contract.test.ts checks each against packages/core/openapi.json, so a fake
// that drifts from the server fails a test instead of hiding a bug.

const totals = (runs: number, high: number, medium: number, low: number, errors: number, costMicro: number, savingsMicro: number) => ({
  runs,
  bandHigh: high,
  bandMedium: medium,
  bandLow: low,
  errors,
  inputTokens: runs * 400,
  outputTokens: runs * 3,
  systemOneCostMicroUsd: costMicro,
  counterfactualMicroUsd: costMicro + savingsMicro,
  savingsMicroUsd: savingsMicro,
  llmCallsAvoided: high,
});

/** GET /usage: UsageGetResponse. */
export const USAGE_REPLY = {
  from: "2026-09-30T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
  sets: [
    { setId: "6b0f8c1e-2a4d-4f6e-9a1b-3c5d7e9f1a2b", slug: "model-tier", ...totals(1, 0, 1, 0, 0, 50, 0) },
    { setId: "0d4e2f6a-8b1c-4d3e-a5f7-9b1c3d5e7f9a", slug: "done-check", ...totals(2, 1, 0, 1, 1, 120, 2_000) },
  ],
  totals: totals(3, 1, 1, 1, 1, 170, 2_000),
  days: [{ day: "2026-09-30", runs: 3, errors: 1, systemOneCostMicroUsd: 170, counterfactualMicroUsd: 2_170, savingsMicroUsd: 2_000, llmCallsAvoided: 1 }],
};

/** POST /sets/{ref}/channels/{channel}/rollback: ChannelRollbackResponse. */
export const ROLLBACK_REPLY = { channel: "production", fromVersion: 3, toVersion: 2, stage: "shadow" };

/** Each reply and the OpenAPI component it must match. */
export const REPLY_SCHEMAS: ReadonlyArray<{ name: string; schema: string; reply: unknown }> = [
  { name: "USAGE_REPLY", schema: "UsageGetResponse", reply: USAGE_REPLY },
  { name: "ROLLBACK_REPLY", schema: "ChannelRollbackResponse", reply: ROLLBACK_REPLY },
];
