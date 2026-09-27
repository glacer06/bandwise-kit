// Per-call timeout and retry budget from what is left of the run's latency budget.
// This configures the SDK's own retries; it is never a second
// retry loop. The SDK's timeout is per attempt, so the attempts share what is left.

import type { RetryBudget } from "../contracts/ports.js";

export interface CallBudget {
  /** Per attempt. */
  timeoutMs: number;
  retry: RetryBudget;
}

/** Retries allowed for the time left: two with 4 s or more, one with 1.5 s or more, else none. */
export function callBudget(remainingMs: number): CallBudget {
  const remaining = Math.max(0, Math.floor(remainingMs));
  const maxRetries = remaining >= 4_000 ? 2 : remaining >= 1_500 ? 1 : 0;
  return {
    timeoutMs: Math.max(1, Math.floor(remaining / (maxRetries + 1))),
    retry: { maxRetries, maxRetryAfterMs: Math.floor(remaining / 2) },
  };
}
