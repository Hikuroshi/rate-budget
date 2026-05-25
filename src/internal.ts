import { THRESHOLD_PCT } from "./constants.js";
import type {
  Hold,
  Key,
  KeyInput,
  KeyState,
  QuotaState,
  TokenReq,
} from "./types.js";

export function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

export function int(value: number, fallback = 0) {
  return Math.floor(finite(value, fallback));
}

export function pos(value: number, fallback = 1) {
  return Math.max(1, int(value, fallback));
}

export function nonNeg(value: number, fallback = 0) {
  return Math.max(0, int(value, fallback));
}

export function pct(value: number, fallback = THRESHOLD_PCT) {
  return Math.min(100, Math.max(0, finite(value, fallback)));
}

export function ratio(used: number, limit: number) {
  return limit <= 0 ? 1 : used / limit;
}

export function defaultDayKey(now: number) {
  return new Date(now).toISOString().slice(0, 10);
}

export function defaultResetAt(now: number) {
  const date = new Date(now);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

let idSeq = 0;

export function defaultId() {
  idSeq = (idSeq + 1) % Number.MAX_SAFE_INTEGER;

  return `${Date.now().toString(36)}-${idSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function defaultEstimate(req: unknown) {
  if (typeof req === "number") {
    return req;
  }

  if (req && typeof req === "object" && "tokens" in req) {
    const tokens = (req as TokenReq).tokens;

    return typeof tokens === "number" ? tokens : 1;
  }

  return 1;
}

export function emptyState(): QuotaState {
  return { keys: Object.create(null) as Record<string, KeyState> };
}

export function normalizeKey(key: Key) {
  return {
    id: String(key.id),
    rpm: pos(key.rpm),
    tpm: pos(key.tpm),
    rpd: pos(key.rpd),
    priority: int(key.priority ?? 0),
    enabled: key.enabled !== false,
  };
}

export function normalizeState(state: QuotaState) {
  state.keys ??= Object.create(null) as Record<string, KeyState>;

  return state;
}

export function getKeyState(state: QuotaState, key: string, day: string) {
  const keys = normalizeState(state).keys;
  const current = keys[key];

  if (!current) {
    const next: KeyState = {
      day,
      used: 0,
      hits: [],
      holds: Object.create(null) as Record<string, Hold>,
    };
    keys[key] = next;

    return next;
  }

  current.hits ??= [];
  current.holds ??= Object.create(null) as Record<string, Hold>;
  current.used = nonNeg(current.used);

  if (current.day !== day) {
    current.day = day;
    current.used = 0;
  }

  return current;
}

export function pruneHits(state: KeyState, now: number, windowMs: number) {
  const minAt = now - windowMs;

  state.hits = state.hits.filter(
    (hit) =>
      Number.isFinite(hit.at) &&
      hit.at >= minAt &&
      hit.at <= now &&
      nonNeg(hit.tokens) > 0,
  );
}

export function toKeyList<K extends Key>(keys: KeyInput<K>) {
  return Array.isArray(keys) ? keys : [keys];
}
