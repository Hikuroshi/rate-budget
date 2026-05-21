import {
  DEFAULT_LIMIT_WINDOW_MS,
  toNonNegativeInteger,
  toPositiveInteger,
} from "./limits.js";

export type PerRequestTokenBudgetInput = {
  tokensPerWindow: number;
  requestSpacingMs: number;
  windowMs?: number;
  minimumTokens?: number;
};

export type FlexibleTokenBudgetPartition<Name extends string = string> = {
  name: Name;
  targetRatio: number;
  maxRatio: number;
};

function normalizeRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export function calculatePerRequestTokenBudget(
  input: PerRequestTokenBudgetInput,
) {
  const tokensPerWindow = toPositiveInteger(input.tokensPerWindow);
  const requestSpacingMs = toPositiveInteger(input.requestSpacingMs);
  const windowMs = toPositiveInteger(
    input.windowMs ?? DEFAULT_LIMIT_WINDOW_MS,
    DEFAULT_LIMIT_WINDOW_MS,
  );
  const requestsPerWindow = windowMs / requestSpacingMs;
  const minimumTokens = toPositiveInteger(input.minimumTokens ?? 1);

  return Math.max(
    minimumTokens,
    Math.floor(tokensPerWindow / Math.max(1, requestsPerWindow)),
  );
}

export function calculateTokenBudgetPortion(
  totalBudget: number,
  ratio: number,
) {
  return Math.max(
    1,
    Math.floor(toPositiveInteger(totalBudget) * normalizeRatio(ratio)),
  );
}

export function distributeFlexibleTokenBudget<Name extends string>(input: {
  parentBudget: number;
  availableTokens: number;
  partitions: readonly FlexibleTokenBudgetPartition<Name>[];
}) {
  const parentBudget = toPositiveInteger(input.parentBudget);
  let remainingTokens = toNonNegativeInteger(input.availableTokens);
  const allocations = Object.create(null) as Record<Name, number>;

  for (const partition of input.partitions) {
    const targetBudget = Math.floor(
      parentBudget * normalizeRatio(partition.targetRatio),
    );
    const allocated = Math.min(targetBudget, remainingTokens);
    allocations[partition.name] = allocated;
    remainingTokens -= allocated;
  }

  for (const partition of input.partitions) {
    if (remainingTokens <= 0) {
      break;
    }

    const currentAllocation = allocations[partition.name] ?? 0;
    const maxBudget = Math.max(
      currentAllocation,
      Math.floor(parentBudget * normalizeRatio(partition.maxRatio)),
    );
    const additionalTokens = Math.min(
      maxBudget - currentAllocation,
      remainingTokens,
    );

    allocations[partition.name] = currentAllocation + additionalTokens;
    remainingTokens -= additionalTokens;
  }

  return allocations;
}
