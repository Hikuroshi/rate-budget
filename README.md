# rate-budget

A multi-key quota decision engine for RPM, TPM, and RPD-aware routing.

`rate-budget` selects an active key within a scope such as a tenant, workspace,
project, user, or guild. Each key has independent RPM, TPM, and RPD limits, so
your application can safely move to another key when one key is cooling down,
under token pressure, or near its daily quota.

The package is lightweight, dependency-free, and storage adapter friendly. Your
application owns the state; `rate-budget` only computes quota decisions and
records reservations through the configured adapter.

## Install

```bash
npm install rate-budget
pnpm add rate-budget
yarn add rate-budget
```

## Core Algorithm

RPM: spacing-based cooldown

```txt
cooldownMs = ceil(60000 / rpm) + bufferMs
```

TPM: sliding 60-second token window

```txt
usedTokensLast60s + estimatedRequestTokens <= tpmLimit
```

RPD: daily threshold guard

```txt
dailyCap = ceil(rpdLimit * thresholdPct / 100)
```

## Quick Start

Use a single key when you do not need key rotation yet.

```ts
import { Quota } from "rate-budget";

const quota = new Quota();
const key = { id: "key-a", rpm: 15, tpm: 250_000, rpd: 500 };

const reserved = await quota.reserve("scope:123", key, { tokens: 800 });

if (!reserved.ok) {
  throw new Error(`Quota blocked: ${reserved.reason}`);
}

await quota.commit(reserved.hold, { tokens: 742 });
```

or use multiple keys with priority.

```ts
import { Quota } from "rate-budget";

const quota = new Quota();

const keys = [
  { id: "key-a", rpm: 15, tpm: 250_000, rpd: 500, priority: 10 },
  { id: "key-b", rpm: 15, tpm: 250_000, rpd: 500, priority: 5 },
];

const reserved = await quota.reserve("tenant:acme", keys, { tokens: 2_400 });

if (!reserved.ok) {
  if (reserved.waitMs !== null) {
    await waitOrQueue(reserved.waitMs);
    return;
  }

  throw new Error(`No quota key available: ${reserved.reason}`);
}

try {
  const response = await callProvider(reserved.key, request);

  await quota.commit(reserved.hold, {
    tokens: response.usage.totalTokens,
  });
} catch (error) {
  await quota.rollback(reserved.hold);
  throw error;
}
```

## API

### `new Quota(options?)`

```ts
const quota = new Quota({
  bufferMs: 1_000,
  thresholdPct: 90,
  estimate: (req) => req.inputTokens + req.maxOutputTokens,
});
```

Options:

- `store`: custom storage adapter. Defaults to `MemoryStore`.
- `estimate(req)`: token estimator. Defaults to `req.tokens`, number request, or `1`.
- `now()`: custom clock.
- `id()`: reservation id generator.
- `windowMs`: token window. Defaults to `60000`.
- `bufferMs`: RPM/TPM safety buffer. Defaults to `1000`.
- `thresholdPct`: RPD threshold percent. Defaults to `100`.
- `dayKey(now)`: daily bucket key. Defaults to UTC `YYYY-MM-DD`.
- `resetAt(now)`: timestamp for the next daily reset. Defaults to next UTC day.

### `reserve(scope, keyOrKeys, req?)`

Selects the best key and immediately creates a reservation for RPM, TPM, and
RPD accounting. `keyOrKeys` can be a single key object or an array of keys.

```ts
const single = await quota.reserve("tenant:acme", key, { tokens: 1_500 });
const result = await quota.reserve("tenant:acme", keys, { tokens: 1_500 });
```

Successful result:

```ts
{
  ok: true,
  key,
  hold,
  tokens: 1500,
  waitMs: 0,
  checks
}
```

Blocked result:

```ts
{
  ok: false,
  reason: "rpm" | "tpm" | "rpd" | "off" | "no_key",
  waitMs: 4500,
  tokens: 1500,
  checks
}
```

`waitMs` is `null` when the request cannot be handled by any key, for example
when the estimated token count is larger than every key's TPM limit.

### `commit(hold, usage?)`

Completes a reservation after the request has actually consumed provider quota.

```ts
await quota.commit(hold, { tokens: actualTokens });
```

### `rollback(hold)`

Cancels a reservation when a request was not sent or failed before provider
quota was consumed.

```ts
await quota.rollback(hold);
```

### `check(scope, keyOrKeys, req?)`

Runs a dry check to see which key would be selected without creating a
reservation. `keyOrKeys` can be a single key object or an array of keys.

```ts
const single = await quota.check("workspace:42", key, { tokens: 800 });
const decision = await quota.check("workspace:42", keys, { tokens: 800 });
```

## Key Shape

```ts
const key = {
  id: "key-a",
  rpm: 15,
  tpm: 250_000,
  rpd: 500,
  priority: 10,
  enabled: true,
};
```

Fields:

- `id`: stable key id.
- `rpm`: requests per minute.
- `tpm`: tokens per minute.
- `rpd`: requests per day.
- `priority`: higher value is preferred. Defaults to `0`.
- `enabled`: set `false` to skip a key. Defaults to `true`.

Extra fields are preserved, so you can attach provider names, encrypted key
references, model names, or metadata.

## Selection Rules

1. Disabled keys are skipped.
2. A key must pass RPD threshold, RPM cooldown, and TPM window checks.
3. Among allowed keys, the highest `priority` wins.
4. Ties prefer lower token pressure, then lower daily pressure, then key id.
5. If no key is allowed, the result returns the shortest useful `waitMs`.

## Storage Adapter

`MemoryStore` is useful for one process. For multi-instance systems, implement
`QuotaStore` with Redis, SQL, DynamoDB, or any transactional storage.

```ts
import { Quota } from "rate-budget";

const store = {
  async mutate(scope, fn) {
    return db.transaction(async (tx) => {
      const state = (await tx.loadQuotaState(scope)) ?? { keys: {} };
      const result = fn(state);

      await tx.saveQuotaState(scope, state);

      return result;
    });
  },
};

const quota = new Quota({ store });
```

The `mutate` callback must run atomically per scope. That keeps reservations
safe when many workers route requests at the same time.

## Helpers

- `cooldownMs(rpm, bufferMs?, windowMs?)`
- `tokenWaitMs({ used, tokens, limit, hits, now, windowMs?, bufferMs? })`
- `dailyCap(rpd, thresholdPct?)`
- `MemoryStore`
- `QuotaManager` alias for `Quota`

## Build and Test

```bash
npm run build
npm test
```
