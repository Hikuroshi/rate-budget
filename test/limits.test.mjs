import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryActorCooldownLimiter,
  buildRequestLimitProfile,
  calculatePerRequestTokenBudget,
  evaluateWindowUsage,
  retryAsync,
} from "../dist/esm/index.js";

test("buildRequestLimitProfile normalizes rpm, tpm, rpd, and threshold", () => {
  assert.deepEqual(
    buildRequestLimitProfile({
      rpmLimit: 15,
      tpmLimit: 250_000,
      rpdLimit: 500,
      dailyThresholdPercent: 90,
    }),
    {
      rpmLimit: 15,
      tpmLimit: 250_000,
      rpdLimit: 500,
      dailyThresholdPercent: 90,
      dailyThresholdRequests: 450,
      cooldownMs: 5_000,
      inactiveCooldownMs: 10_000,
    },
  );
});

test("evaluateWindowUsage derives current cost from active window entries", () => {
  const decision = evaluateWindowUsage({
    incomingCost: 40,
    limit: 100,
    now: 120_000,
    entries: [
      { occurredAt: 10_000, cost: 90 },
      { occurredAt: 90_000, cost: 70 },
    ],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "window_exhausted");
  assert.equal(decision.retryAfterMs, 31_000);
});

test("calculatePerRequestTokenBudget uses spacing and window size", () => {
  assert.equal(
    calculatePerRequestTokenBudget({
      tokensPerWindow: 250_000,
      requestSpacingMs: 5_000,
      minimumTokens: 96,
    }),
    20_833,
  );
});

test("InMemoryActorCooldownLimiter supports same and different actor cooldowns", () => {
  const limiter = new InMemoryActorCooldownLimiter({
    sameActorCooldownMs: 3_000,
    differentActorCooldownMs: 1_000,
  });

  assert.equal(limiter.consume("guild-a", "user-a", 0).allowed, true);

  const sameActorDecision = limiter.consume("guild-a", "user-a", 500);
  assert.equal(sameActorDecision.allowed, false);
  assert.equal(sameActorDecision.retryAfterMs, 2_500);

  const differentActorDecision = limiter.consume("guild-a", "user-b", 500);
  assert.equal(differentActorDecision.allowed, false);
  assert.equal(differentActorDecision.retryAfterMs, 500);
});

test("retryAsync retries retryable failures", async () => {
  let attempts = 0;
  const result = await retryAsync({
    retryAttempts: 2,
    task: async () => {
      attempts += 1;

      if (attempts < 2) {
        const error = new Error("rate limit");
        error.status = 429;
        throw error;
      }

      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});
