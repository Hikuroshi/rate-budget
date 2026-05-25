import { BUFFER_MS, THRESHOLD_PCT, WINDOW_MS } from "./constants.js";
import {
  defaultDayKey,
  defaultEstimate,
  defaultId,
  defaultResetAt,
  getKeyState,
  nonNeg,
  normalizeKey,
  pct,
  pos,
  pruneHits,
  ratio,
  toKeyList,
} from "./internal.js";
import { cooldownMs, dailyCap, tokenWaitMs } from "./limits.js";
import { MemoryStore } from "./store.js";
import type {
  BlockReason,
  CheckResult,
  CommitUsage,
  Hold,
  Key,
  KeyCheck,
  KeyInput,
  QuotaOptions,
  QuotaState,
  QuotaStore,
  ReserveResult,
  TokenEstimator,
  TokenReq,
} from "./types.js";

function resolveKeyBlock(
  waits: Array<{ reason: BlockReason; waitMs: number }>,
) {
  if (waits.length === 0) {
    return null;
  }

  return waits.reduce((max, item) =>
    item.waitMs > max.waitMs ? item : max,
  );
}

function waitUntil(resetAt: (now: number) => number, now: number) {
  return Math.max(0, nonNeg(resetAt(now) - now));
}

function bestBlocked(checks: readonly KeyCheck[]) {
  const retryable = checks.filter(
    (check): check is KeyCheck & { waitMs: number } =>
      !check.ok && check.waitMs !== null,
  );

  if (retryable.length > 0) {
    return retryable.reduce((best, check) =>
      check.waitMs < best.waitMs ? check : best,
    );
  }

  return checks.find((check) => !check.ok) ?? null;
}

function compareAllowed(left: KeyCheck, right: KeyCheck) {
  return (
    right.priority - left.priority ||
    left.tokenPct - right.tokenPct ||
    left.dailyPct - right.dailyPct ||
    left.key.localeCompare(right.key)
  );
}

export class Quota<K extends Key = Key, Req = TokenReq> {
  private readonly store: QuotaStore;
  private readonly estimate: TokenEstimator<Req>;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly windowMs: number;
  private readonly bufferMs: number;
  private readonly thresholdPct: number;
  private readonly dayKey: (now: number) => string;
  private readonly resetAt: (now: number) => number;

  constructor(options: QuotaOptions<Req> = {}) {
    this.store = options.store ?? new MemoryStore();
    this.estimate = options.estimate ?? (defaultEstimate as TokenEstimator<Req>);
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? defaultId;
    this.windowMs = pos(options.windowMs ?? WINDOW_MS, WINDOW_MS);
    this.bufferMs = nonNeg(options.bufferMs ?? BUFFER_MS, BUFFER_MS);
    this.thresholdPct = pct(options.thresholdPct ?? THRESHOLD_PCT);
    this.dayKey = options.dayKey ?? defaultDayKey;
    this.resetAt = options.resetAt ?? defaultResetAt;
  }

  async check(
    scope: string,
    keys: KeyInput<K>,
    req?: Req,
  ): Promise<CheckResult<K>> {
    const now = this.now();
    const day = this.dayKey(now);
    const tokens = nonNeg(await this.estimate(req));

    return this.store.mutate(scope, (state) =>
      this.pick(state, toKeyList(keys), tokens, now, day),
    );
  }

  async reserve(
    scope: string,
    keys: KeyInput<K>,
    req?: Req,
  ): Promise<ReserveResult<K>> {
    const now = this.now();
    const day = this.dayKey(now);
    const tokens = nonNeg(await this.estimate(req));

    return this.store.mutate(scope, (state) => {
      const picked = this.pick(state, toKeyList(keys), tokens, now, day);

      if (!picked.ok) {
        return picked;
      }

      const keyState = getKeyState(state, picked.key.id, day);
      const hold: Hold = {
        id: this.nextId(),
        scope,
        key: picked.key.id,
        tokens,
        at: now,
        day,
        prevAt: keyState.lastAt,
        prevId: keyState.lastId,
      };

      keyState.used += 1;
      keyState.lastAt = now;
      keyState.lastId = hold.id;
      keyState.hits.push({ id: hold.id, at: now, tokens });
      keyState.holds[hold.id] = hold;

      return {
        ...picked,
        hold,
      };
    });
  }

  async commit(hold: Hold, usage: CommitUsage = {}) {
    const tokens =
      usage.tokens === undefined ? undefined : nonNeg(usage.tokens, hold.tokens);

    return this.store.mutate(hold.scope, (state) => {
      const keyState = state.keys?.[hold.key];
      const stored = keyState?.holds?.[hold.id];

      if (!keyState || !stored) {
        return false;
      }

      if (tokens !== undefined) {
        const hit = keyState.hits.find((item) => item.id === hold.id);

        if (hit) {
          hit.tokens = tokens;
        }

        stored.tokens = tokens;
      }

      delete keyState.holds[hold.id];

      return true;
    });
  }

  async rollback(hold: Hold) {
    return this.store.mutate(hold.scope, (state) => {
      const keyState = state.keys?.[hold.key];
      const stored = keyState?.holds?.[hold.id];

      if (!keyState || !stored) {
        return false;
      }

      keyState.hits = keyState.hits.filter((hit) => hit.id !== hold.id);

      if (keyState.day === stored.day) {
        keyState.used = Math.max(0, keyState.used - 1);
      }

      if (keyState.lastId === hold.id) {
        keyState.lastAt = stored.prevAt;
        keyState.lastId = stored.prevId;
      }

      delete keyState.holds[hold.id];

      return true;
    });
  }

  private pick(
    state: QuotaState,
    keys: readonly K[],
    tokens: number,
    now: number,
    day: string,
  ): CheckResult<K> {
    const checks = keys.map((key) => this.checkKey(state, key, tokens, now, day));
    const allowed = checks
      .filter((check) => check.ok)
      .sort(compareAllowed);

    if (allowed[0]) {
      const key = keys.find((item) => item.id === allowed[0]?.key);

      if (key) {
        return {
          ok: true,
          key,
          tokens,
          waitMs: 0,
          checks,
        };
      }
    }

    const blocked = bestBlocked(checks);

    return {
      ok: false,
      reason: blocked?.reason ?? "no_key",
      tokens,
      waitMs: blocked?.waitMs ?? null,
      checks,
    };
  }

  private checkKey(
    state: QuotaState,
    key: K,
    tokens: number,
    now: number,
    day: string,
  ): KeyCheck {
    const config = normalizeKey(key);
    const keyState = getKeyState(state, config.id, day);
    pruneHits(keyState, now, this.windowMs);

    const cap = dailyCap(config.rpd, this.thresholdPct);
    const tokenUsed = keyState.hits.reduce(
      (sum, hit) => sum + nonNeg(hit.tokens),
      0,
    );
    const rpmWait = keyState.lastAt !== undefined
      ? Math.max(
          0,
          cooldownMs(config.rpm, this.bufferMs, this.windowMs) -
            (now - keyState.lastAt),
        )
      : 0;
    const tpmWait = tokenWaitMs({
      used: tokenUsed,
      tokens,
      limit: config.tpm,
      hits: keyState.hits,
      now,
      windowMs: this.windowMs,
      bufferMs: this.bufferMs,
    });
    const dailyLeft = Math.max(0, cap - keyState.used);
    const waits: Array<{ reason: BlockReason; waitMs: number }> = [];

    if (!config.enabled) {
      return {
        key: config.id,
        ok: false,
        reason: "off",
        waitMs: null,
        priority: config.priority,
        rpmMs: rpmWait,
        tpmMs: tpmWait,
        tokenUsed,
        tokenPct: ratio(tokenUsed, config.tpm),
        dailyUsed: keyState.used,
        dailyCap: cap,
        dailyLeft,
        dailyPct: ratio(keyState.used, cap),
      };
    }

    if (dailyLeft <= 0) {
      waits.push({ reason: "rpd", waitMs: waitUntil(this.resetAt, now) });
    }

    if (rpmWait > 0) {
      waits.push({ reason: "rpm", waitMs: rpmWait });
    }

    if (tpmWait === null) {
      return {
        key: config.id,
        ok: false,
        reason: "tpm",
        waitMs: null,
        priority: config.priority,
        rpmMs: rpmWait,
        tpmMs: tpmWait,
        tokenUsed,
        tokenPct: ratio(tokenUsed, config.tpm),
        dailyUsed: keyState.used,
        dailyCap: cap,
        dailyLeft,
        dailyPct: ratio(keyState.used, cap),
      };
    }

    if (tpmWait > 0) {
      waits.push({ reason: "tpm", waitMs: tpmWait });
    }

    const block = resolveKeyBlock(waits);

    return {
      key: config.id,
      ok: block === null,
      reason: block?.reason,
      waitMs: block?.waitMs ?? 0,
      priority: config.priority,
      rpmMs: rpmWait,
      tpmMs: tpmWait,
      tokenUsed,
      tokenPct: ratio(tokenUsed, config.tpm),
      dailyUsed: keyState.used,
      dailyCap: cap,
      dailyLeft,
      dailyPct: ratio(keyState.used, cap),
    };
  }
}

export { Quota as QuotaManager };
