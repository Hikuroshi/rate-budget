import { toNonNegativeInteger } from "./limits.js";

export type RetryableErrorOptions = {
  statusCodes?: readonly number[];
  messageIncludes?: readonly string[];
};

export type RetryDelay =
  | number
  | ((input: { attemptIndex: number; error: unknown }) => number);

export type RetryAsyncInput<T> = {
  task: (input: { attemptIndex: number }) => Promise<T>;
  retryAttempts: number;
  delayMs?: RetryDelay;
  shouldRetry?: (error: unknown, input: { attemptIndex: number }) => boolean;
  onRetry?: (input: {
    attemptIndex: number;
    nextDelayMs: number;
    error: unknown;
  }) => void | Promise<void>;
};

export function delay(ms: number) {
  const safeMs = toNonNegativeInteger(ms);

  if (safeMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

export function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }

  const status = error.status;

  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "";
}

export function isRetryableError(
  error: unknown,
  options: RetryableErrorOptions = {},
) {
  const statusCodes = options.statusCodes ?? [429, 500, 503];
  const status = getErrorStatus(error);

  if (status !== null && statusCodes.includes(status)) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();

  return (options.messageIncludes ?? []).some((fragment) =>
    message.includes(fragment.toLowerCase()),
  );
}

function resolveRetryDelay(
  delayMs: RetryDelay | undefined,
  input: { attemptIndex: number; error: unknown },
) {
  if (typeof delayMs === "function") {
    return toNonNegativeInteger(delayMs(input));
  }

  return toNonNegativeInteger(delayMs ?? 0);
}

export async function retryAsync<T>(input: RetryAsyncInput<T>) {
  const retryAttempts = toNonNegativeInteger(input.retryAttempts);
  const maxAttempts = retryAttempts + 1;
  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    try {
      return await input.task({ attemptIndex });
    } catch (error) {
      lastError = error;

      if (attemptIndex >= maxAttempts - 1) {
        break;
      }

      const shouldRetry = input.shouldRetry
        ? input.shouldRetry(error, { attemptIndex })
        : isRetryableError(error);

      if (!shouldRetry) {
        break;
      }

      const nextDelayMs = resolveRetryDelay(input.delayMs, {
        attemptIndex,
        error,
      });

      await input.onRetry?.({
        attemptIndex,
        nextDelayMs,
        error,
      });
      await delay(nextDelayMs);
    }
  }

  throw lastError;
}
