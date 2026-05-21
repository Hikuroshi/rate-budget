# rate-budget

`rate-budget` is a small, dependency-free toolkit for calculating request rate
limits, quota thresholds, token or cost budgets, cooldowns, and retries.

It is provider-agnostic and storage-agnostic. The package does not manage your
database, Redis keys, queues, locks, or HTTP clients. Your application owns the
state; `rate-budget` only calculates deterministic decisions from the counters
and events you pass in.

## Installation

```bash
npm install rate-budget
pnpm add rate-budget
yarn add rate-budget
```

## Features

- Request spacing for limits such as RPM, RPH, or any count-per-window limit.
- Sliding-window cost checks for tokens, bytes, credits, points, or custom units.
- Daily quota thresholds such as RPD with configurable safety percentages.
- Per-request token or cost budget planning.
- Flexible budget splitting for context, input, output, metadata, and similar allocations.
- Lightweight in-memory actor cooldowns for single-process use cases.
- Async retry helper with configurable status codes, message fragments, and delays.
- ESM and CommonJS exports.
- TypeScript declarations.
- Zero runtime dependencies.

## Imports

ESM:

```ts
import {
  buildRequestLimitProfile,
  calculateWindowUsageWaitMs,
} from "rate-budget";
```

CommonJS:

```js
const {
  buildRequestLimitProfile,
  calculateWindowUsageWaitMs,
} = require("rate-budget");
```

## Core Model

`rate-budget` is designed around pure calculations:

1. Read current usage and recent events from your own storage.
2. Pass those values into `rate-budget`.
3. If the decision requires waiting, delay or enqueue in your application.
4. If the request is allowed, reserve or log the request atomically.
5. After the request finishes, update usage in your storage.

This keeps the package lightweight while still fitting distributed systems,
serverless applications, workers, bots, and API gateways.

## RPM, TPM, and RPD Example

```ts
import {
  buildRequestLimitProfile,
  calculateCooldownWaitMs,
  calculateWindowUsageWaitMs,
  evaluateCountLimit,
} from "rate-budget";

const profile = buildRequestLimitProfile({
  rpmLimit: 15,
  tpmLimit: 250_000,
  rpdLimit: 500,
  dailyThresholdPercent: 90,
});

const dailyDecision = evaluateCountLimit({
  usedCount: usageToday.requestCount,
  limit: profile.rpdLimit,
  thresholdPercent: profile.dailyThresholdPercent,
});

if (!dailyDecision.allowed) {
  throw new Error("Daily quota threshold reached.");
}

const cooldownWaitMs = calculateCooldownWaitMs({
  lastAcceptedAt: lastApiRequest?.createdAt,
  cooldownMs: profile.cooldownMs,
});

const tokenWaitMs = calculateWindowUsageWaitMs({
  incomingCost: estimatedRequestTokens,
  limit: profile.tpmLimit,
  entries: recentApiRequests.map((request) => ({
    occurredAt: request.createdAt,
    cost: request.totalTokens,
  })),
});

const waitMs = Math.max(cooldownWaitMs, tokenWaitMs);

if (waitMs > 0) {
  await waitOrQueue(waitMs);
}
```

## Sliding-Window Cost Limit

Use `evaluateWindowUsage` when you need the full decision, or
`calculateWindowUsageWaitMs` when you only need the wait time.

```ts
import { evaluateWindowUsage } from "rate-budget";

const decision = evaluateWindowUsage({
  incomingCost: 500,
  limit: 10_000,
  windowMs: 60_000,
  safetyBufferMs: 1_000,
  entries: [
    { occurredAt: "2026-05-21 14:00:10", cost: 4_000 },
    { occurredAt: "2026-05-21 14:00:30", cost: 6_200 },
  ],
});

if (!decision.allowed && decision.retryAfterMs !== null) {
  await delay(decision.retryAfterMs);
}
```

`cost` can represent tokens, weighted requests, bytes, credits, or any other
unit that should be limited over time.

## Token Budget Planning

```ts
import {
  calculatePerRequestTokenBudget,
  calculateTokenBudgetPortion,
  distributeFlexibleTokenBudget,
} from "rate-budget";

const totalBudget = calculatePerRequestTokenBudget({
  tokensPerWindow: 250_000,
  requestSpacingMs: 5_000,
  minimumTokens: 96,
});

const inputBudget = calculateTokenBudgetPortion(totalBudget, 0.5);

const flexible = distributeFlexibleTokenBudget({
  parentBudget: inputBudget,
  availableTokens: inputBudget - systemPromptTokens - userPromptTokens,
  partitions: [
    { name: "context", targetRatio: 0.55, maxRatio: 0.6 },
    { name: "metadata", targetRatio: 0.15, maxRatio: 0.2 },
  ],
});

console.log(flexible.context, flexible.metadata);
```

## In-Memory Actor Cooldowns

Use `InMemoryActorCooldownLimiter` for local process cooldowns, such as UX
cooldowns in a bot or simple API server. For multi-instance systems, store the
cooldown state in Redis or a database and use the pure helpers instead.

```ts
import { InMemoryActorCooldownLimiter } from "rate-budget";

const limiter = new InMemoryActorCooldownLimiter({
  sameActorCooldownMs: 3_000,
  differentActorCooldownMs: 1_000,
  stateTtlMs: 5 * 60_000,
});

const decision = limiter.consume("guild:123", "user:456");

if (!decision.allowed) {
  console.log(`Retry after ${decision.retryAfterMs}ms`);
}
```

## Retry

```ts
import { retryAsync, isRetryableError } from "rate-budget";

const response = await retryAsync({
  retryAttempts: 2,
  delayMs: ({ attemptIndex }) => 1_000 * (attemptIndex + 1),
  shouldRetry: (error) =>
    isRetryableError(error, {
      statusCodes: [429, 500, 502, 503, 504],
      messageIncludes: ["rate limit", "temporarily unavailable"],
    }),
  task: () => fetchProvider(),
});
```

## API Overview

- `buildRequestLimitProfile(input)`: creates a normalized RPM, TPM, RPD, threshold, cooldown, and inactive cooldown profile.
- `calculateLimitSpacingMs(limitPerWindow, options)`: calculates safe request spacing inside a time window.
- `calculateInactiveLimitSpacingMs(limitPerWindow, options)`: calculates inactive cooldown spacing with a multiplier.
- `calculateThresholdCount(limit, thresholdPercent)`: calculates a safe quota threshold.
- `evaluateCountLimit(input)`: evaluates count-based quota usage.
- `calculateCooldownWaitMs(input)`: calculates remaining cooldown from the last accepted timestamp.
- `evaluateWindowUsage(input)`: evaluates sliding-window cost usage and returns a detailed decision.
- `calculateWindowUsageWaitMs(input)`: returns only the wait time for sliding-window cost usage.
- `calculatePerRequestTokenBudget(input)`: calculates cost or token budget per request.
- `calculateTokenBudgetPortion(totalBudget, ratio)`: returns a ratio-based budget portion.
- `distributeFlexibleTokenBudget(input)`: allocates flexible budget across named partitions.
- `InMemoryActorCooldownLimiter`: local in-memory cooldown per scope and actor.
- `retryAsync(input)`: retries an async task.
- `isRetryableError(error, options)`: checks status codes and message fragments.
- `delay(ms)`: small promise-based delay helper.

## Build and Test

```bash
pnpm --filter rate-budget build
pnpm --filter rate-budget test
```

From the package directory:

```bash
npm run build
npm test
```
