export const DEFAULT_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_LIMIT_SAFETY_BUFFER_MS = 1_000;
export const DEFAULT_INACTIVE_COOLDOWN_MULTIPLIER = 2;

export type TimestampInput = Date | number | string | null | undefined;

export type LimitWindowOptions = {
  windowMs?: number;
  safetyBufferMs?: number;
};

export type RequestLimitProfileInput = {
  rpmLimit: number;
  tpmLimit: number;
  rpdLimit: number;
  dailyThresholdPercent?: number;
  windowMs?: number;
  safetyBufferMs?: number;
  inactiveCooldownMultiplier?: number;
};

export type RequestLimitProfile = {
  rpmLimit: number;
  tpmLimit: number;
  rpdLimit: number;
  dailyThresholdPercent: number;
  dailyThresholdRequests: number;
  cooldownMs: number;
  inactiveCooldownMs: number;
};

export type CountLimitDecision =
  | {
      allowed: true;
      usedCount: number;
      thresholdCount: number;
      remainingCount: number;
    }
  | {
      allowed: false;
      usedCount: number;
      thresholdCount: number;
      remainingCount: 0;
    };

export type WindowUsageEntry = {
  occurredAt: TimestampInput;
  cost: number;
};

export type WindowUsageInput = LimitWindowOptions & {
  currentCost?: number;
  incomingCost: number;
  limit: number;
  entries: readonly WindowUsageEntry[];
  now?: number;
  entriesSortedOldestFirst?: boolean;
};

export type WindowUsageDecision =
  | {
      allowed: true;
      reason: "within_limit";
      projectedCost: number;
      limit: number;
      retryAfterMs: 0;
    }
  | {
      allowed: false;
      reason: "single_request_exceeds_limit";
      projectedCost: number;
      limit: number;
      retryAfterMs: null;
    }
  | {
      allowed: false;
      reason: "window_exhausted";
      projectedCost: number;
      limit: number;
      retryAfterMs: number;
    };

function normalizeFiniteNumber(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

export function toPositiveInteger(value: number, fallback = 1) {
  return Math.max(1, Math.floor(normalizeFiniteNumber(value, fallback)));
}

export function toNonNegativeInteger(value: number, fallback = 0) {
  return Math.max(0, Math.floor(normalizeFiniteNumber(value, fallback)));
}

export function clampPercent(value: number, fallback = 100) {
  const safeValue = normalizeFiniteNumber(value, fallback);

  return Math.min(100, Math.max(0, safeValue));
}

export function toTimestampMs(value: TimestampInput) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

export function calculateLimitSpacingMs(
  limitPerWindow: number,
  options: LimitWindowOptions = {},
) {
  const limit = toPositiveInteger(limitPerWindow);
  const windowMs = toPositiveInteger(
    options.windowMs ?? DEFAULT_LIMIT_WINDOW_MS,
    DEFAULT_LIMIT_WINDOW_MS,
  );
  const safetyBufferMs = toNonNegativeInteger(
    options.safetyBufferMs ?? DEFAULT_LIMIT_SAFETY_BUFFER_MS,
    DEFAULT_LIMIT_SAFETY_BUFFER_MS,
  );

  return Math.ceil(windowMs / limit + safetyBufferMs);
}

export function calculateInactiveLimitSpacingMs(
  limitPerWindow: number,
  options: LimitWindowOptions & { multiplier?: number } = {},
) {
  const multiplier = Math.max(
    1,
    normalizeFiniteNumber(
      options.multiplier ?? DEFAULT_INACTIVE_COOLDOWN_MULTIPLIER,
      DEFAULT_INACTIVE_COOLDOWN_MULTIPLIER,
    ),
  );

  return Math.ceil(calculateLimitSpacingMs(limitPerWindow, options) * multiplier);
}

export function calculateThresholdCount(
  limit: number,
  thresholdPercent = 100,
) {
  const safeLimit = toPositiveInteger(limit);
  const safeThresholdPercent = clampPercent(thresholdPercent);

  return Math.max(1, Math.ceil(safeLimit * (safeThresholdPercent / 100)));
}

export function evaluateCountLimit(input: {
  usedCount: number;
  limit: number;
  thresholdPercent?: number;
}): CountLimitDecision {
  const usedCount = toNonNegativeInteger(input.usedCount);
  const thresholdCount = calculateThresholdCount(
    input.limit,
    input.thresholdPercent,
  );
  const remainingCount = Math.max(0, thresholdCount - usedCount);

  if (remainingCount <= 0) {
    return {
      allowed: false,
      usedCount,
      thresholdCount,
      remainingCount: 0,
    };
  }

  return {
    allowed: true,
    usedCount,
    thresholdCount,
    remainingCount,
  };
}

export function calculateCooldownWaitMs(input: {
  lastAcceptedAt: TimestampInput;
  cooldownMs: number;
  now?: number;
}) {
  const lastAcceptedAt = toTimestampMs(input.lastAcceptedAt);

  if (lastAcceptedAt === null) {
    return 0;
  }

  const now = normalizeFiniteNumber(input.now ?? Date.now(), Date.now());
  const cooldownMs = toNonNegativeInteger(input.cooldownMs);

  return Math.max(0, cooldownMs - (now - lastAcceptedAt));
}

function normalizeWindowEntries(
  entries: readonly WindowUsageEntry[],
  entriesSortedOldestFirst: boolean,
  input: {
    now: number;
    windowMs: number;
  },
) {
  const normalized = entries.flatMap((entry) => {
    const occurredAtMs = toTimestampMs(entry.occurredAt);

    if (
      occurredAtMs === null ||
      occurredAtMs < input.now - input.windowMs ||
      occurredAtMs > input.now
    ) {
      return [];
    }

    return [
      {
        occurredAtMs,
        cost: toNonNegativeInteger(entry.cost),
      },
    ];
  });

  if (entriesSortedOldestFirst) {
    return normalized;
  }

  return normalized.sort((left, right) => left.occurredAtMs - right.occurredAtMs);
}

export function evaluateWindowUsage(
  input: WindowUsageInput,
): WindowUsageDecision {
  const limit = toPositiveInteger(input.limit);
  const incomingCost = toNonNegativeInteger(input.incomingCost);
  const now = normalizeFiniteNumber(input.now ?? Date.now(), Date.now());
  const windowMs = toPositiveInteger(
    input.windowMs ?? DEFAULT_LIMIT_WINDOW_MS,
    DEFAULT_LIMIT_WINDOW_MS,
  );
  const entries = normalizeWindowEntries(
    input.entries,
    input.entriesSortedOldestFirst ?? true,
    { now, windowMs },
  );
  const currentCost =
    input.currentCost === undefined
      ? entries.reduce((sum, entry) => sum + entry.cost, 0)
      : toNonNegativeInteger(input.currentCost);
  const projectedCost = currentCost + incomingCost;

  if (incomingCost > limit) {
    return {
      allowed: false,
      reason: "single_request_exceeds_limit",
      projectedCost,
      limit,
      retryAfterMs: null,
    };
  }

  if (projectedCost <= limit) {
    return {
      allowed: true,
      reason: "within_limit",
      projectedCost,
      limit,
      retryAfterMs: 0,
    };
  }

  const safetyBufferMs = toNonNegativeInteger(
    input.safetyBufferMs ?? DEFAULT_LIMIT_SAFETY_BUFFER_MS,
    DEFAULT_LIMIT_SAFETY_BUFFER_MS,
  );
  let remainingCost = projectedCost;

  for (const entry of entries) {
    remainingCost -= entry.cost;

    if (remainingCost <= limit) {
      return {
        allowed: false,
        reason: "window_exhausted",
        projectedCost,
        limit,
        retryAfterMs: Math.max(
          0,
          windowMs - (now - entry.occurredAtMs) + safetyBufferMs,
        ),
      };
    }
  }

  return {
    allowed: false,
    reason: "window_exhausted",
    projectedCost,
    limit,
    retryAfterMs: windowMs,
  };
}

export function calculateWindowUsageWaitMs(input: WindowUsageInput) {
  const decision = evaluateWindowUsage(input);

  if (decision.allowed) {
    return 0;
  }

  return (
    decision.retryAfterMs ??
    toPositiveInteger(
      input.windowMs ?? DEFAULT_LIMIT_WINDOW_MS,
      DEFAULT_LIMIT_WINDOW_MS,
    )
  );
}

export function buildRequestLimitProfile(
  input: RequestLimitProfileInput,
): RequestLimitProfile {
  const rpmLimit = toPositiveInteger(input.rpmLimit);
  const tpmLimit = toPositiveInteger(input.tpmLimit);
  const rpdLimit = toPositiveInteger(input.rpdLimit);
  const dailyThresholdPercent = clampPercent(input.dailyThresholdPercent ?? 100);
  const cooldownOptions = {
    windowMs: input.windowMs,
    safetyBufferMs: input.safetyBufferMs,
  };

  return {
    rpmLimit,
    tpmLimit,
    rpdLimit,
    dailyThresholdPercent,
    dailyThresholdRequests: calculateThresholdCount(
      rpdLimit,
      dailyThresholdPercent,
    ),
    cooldownMs: calculateLimitSpacingMs(rpmLimit, cooldownOptions),
    inactiveCooldownMs: calculateInactiveLimitSpacingMs(rpmLimit, {
      ...cooldownOptions,
      multiplier: input.inactiveCooldownMultiplier,
    }),
  };
}
