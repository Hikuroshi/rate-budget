export type Awaitable<T> = T | Promise<T>;

export type Key = {
  id: string;
  rpm: number;
  tpm: number;
  rpd: number;
  priority?: number;
  enabled?: boolean;
};

export type KeyInput<K extends Key = Key> = K | readonly K[];

export type TokenReq = {
  tokens?: number;
};

export type Hold = {
  id: string;
  scope: string;
  key: string;
  tokens: number;
  at: number;
  day: string;
  prevAt?: number;
  prevId?: string;
};

export type Hit = {
  id: string;
  at: number;
  tokens: number;
};

export type KeyState = {
  day: string;
  used: number;
  lastAt?: number;
  lastId?: string;
  hits: Hit[];
  holds: Record<string, Hold>;
};

export type QuotaState = {
  keys: Record<string, KeyState>;
};

export type QuotaStore = {
  mutate<T>(
    scope: string,
    fn: (state: QuotaState) => T,
  ): Awaitable<T>;
};

export type TokenEstimator<Req = unknown> = (
  req: Req | undefined,
) => Awaitable<number>;

export type QuotaOptions<Req = unknown> = {
  store?: QuotaStore;
  estimate?: TokenEstimator<Req>;
  now?: () => number;
  id?: () => string;
  windowMs?: number;
  bufferMs?: number;
  thresholdPct?: number;
  dayKey?: (now: number) => string;
  resetAt?: (now: number) => number;
};

export type BlockReason = "rpm" | "tpm" | "rpd" | "off" | "no_key";

export type KeyCheck = {
  key: string;
  ok: boolean;
  reason?: BlockReason;
  waitMs: number | null;
  priority: number;
  rpmMs: number;
  tpmMs: number | null;
  tokenUsed: number;
  tokenPct: number;
  dailyUsed: number;
  dailyCap: number;
  dailyLeft: number;
  dailyPct: number;
};

export type CheckOk<K extends Key = Key> = {
  ok: true;
  key: K;
  tokens: number;
  waitMs: 0;
  checks: KeyCheck[];
};

export type CheckBlocked = {
  ok: false;
  reason: BlockReason;
  tokens: number;
  waitMs: number | null;
  checks: KeyCheck[];
};

export type CheckResult<K extends Key = Key> =
  | CheckOk<K>
  | CheckBlocked;

export type ReserveOk<K extends Key = Key> = CheckOk<K> & {
  hold: Hold;
};

export type ReserveResult<K extends Key = Key> =
  | ReserveOk<K>
  | CheckBlocked;

export type CommitUsage = {
  tokens?: number;
};
