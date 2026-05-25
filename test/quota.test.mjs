import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryStore,
  Quota,
  cooldownMs,
  dailyCap,
  tokenWaitMs,
} from "../dist/esm/index.js";

const keys = [
  { id: "primary", rpm: 15, tpm: 1_000, rpd: 10, priority: 10 },
  { id: "backup", rpm: 15, tpm: 1_000, rpd: 10, priority: 1 },
];
const singleKey = { id: "solo", rpm: 15, tpm: 1_000, rpd: 10 };

test("cooldownMs follows rpm spacing with buffer", () => {
  assert.equal(cooldownMs(15), 5_000);
});

test("dailyCap applies the rpd threshold", () => {
  assert.equal(dailyCap(500, 90), 450);
  assert.equal(dailyCap(500, 0), 0);
});

test("tokenWaitMs uses a sliding 60-second window", () => {
  assert.equal(
    tokenWaitMs({
      used: 900,
      tokens: 200,
      limit: 1_000,
      now: 120_000,
      hits: [{ id: "old", at: 90_000, tokens: 900 }],
    }),
    31_000,
  );
});

test("reserve picks the highest priority key when all limits pass", async () => {
  const quota = new Quota({
    now: () => 0,
    id: () => "hold-1",
  });

  const reserved = await quota.reserve("tenant-a", keys, { tokens: 100 });

  assert.equal(reserved.ok, true);
  assert.equal(reserved.key.id, "primary");
  assert.equal(reserved.hold.id, "hold-1");
});

test("reserve accepts a single key object", async () => {
  const quota = new Quota({
    now: () => 0,
    id: () => "hold-1",
  });

  const reserved = await quota.reserve("tenant-a", singleKey, { tokens: 100 });

  assert.equal(reserved.ok, true);
  assert.equal(reserved.key.id, "solo");
});

test("check accepts a single key object without creating a hold", async () => {
  const store = new MemoryStore();
  const quota = new Quota({
    store,
    now: () => 0,
    id: () => "hold-1",
  });

  const checked = await quota.check("tenant-a", singleKey, { tokens: 100 });

  assert.equal(checked.ok, true);
  assert.equal(checked.key.id, "solo");
  assert.equal(store.get("tenant-a").keys.solo.used, 0);
});

test("reserve falls through to the next key during rpm cooldown", async () => {
  let now = 0;
  const quota = new Quota({
    now: () => now,
    id: () => `hold-${now}`,
  });

  const first = await quota.reserve("tenant-a", keys, { tokens: 100 });
  assert.equal(first.ok, true);
  assert.equal(first.key.id, "primary");

  now = 500;

  const second = await quota.reserve("tenant-a", keys, { tokens: 100 });
  assert.equal(second.ok, true);
  assert.equal(second.key.id, "backup");
});

test("reserve blocks when all keys are cooling down", async () => {
  let now = 0;
  const quota = new Quota({
    now: () => now,
    id: () => `hold-${now}`,
  });

  assert.equal((await quota.reserve("tenant-a", keys, { tokens: 100 })).ok, true);
  assert.equal((await quota.reserve("tenant-a", keys, { tokens: 100 })).ok, true);

  now = 500;

  const blocked = await quota.reserve("tenant-a", keys, { tokens: 100 });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "rpm");
  assert.equal(blocked.waitMs, 4_500);
});

test("commit updates estimated tokens to actual tokens", async () => {
  const store = new MemoryStore();
  const quota = new Quota({
    store,
    now: () => 0,
    id: () => "hold-1",
  });

  const reserved = await quota.reserve("tenant-a", keys, { tokens: 100 });
  assert.equal(reserved.ok, true);

  assert.equal(await quota.commit(reserved.hold, { tokens: 250 }), true);

  const state = store.get("tenant-a");
  assert.equal(state.keys.primary.hits[0].tokens, 250);
  assert.equal(Object.keys(state.keys.primary.holds).length, 0);
});

test("rollback releases rpm, tpm, and rpd reservation state", async () => {
  const store = new MemoryStore();
  const quota = new Quota({
    store,
    now: () => 0,
    id: () => "hold-1",
  });

  const reserved = await quota.reserve("tenant-a", keys, { tokens: 100 });
  assert.equal(reserved.ok, true);

  assert.equal(await quota.rollback(reserved.hold), true);

  const state = store.get("tenant-a");
  assert.equal(state.keys.primary.used, 0);
  assert.equal(state.keys.primary.hits.length, 0);
  assert.equal(state.keys.primary.lastAt, undefined);
});

test("estimate option can derive tokens from custom requests", async () => {
  const quota = new Quota({
    now: () => 0,
    id: () => "hold-1",
    estimate: (req) => req.prompt.length + req.max,
  });

  const reserved = await quota.reserve("tenant-a", keys, {
    prompt: "hello",
    max: 95,
  });

  assert.equal(reserved.ok, true);
  assert.equal(reserved.hold.tokens, 100);
});
