import { BUFFER_MS, THRESHOLD_PCT, WINDOW_MS } from "./constants.js";
import { nonNeg, pct, pos } from "./internal.js";
import type { Hit } from "./types.js";

function sortHits(hits: readonly Hit[]) {
  return [...hits].sort((left, right) => left.at - right.at);
}

export function cooldownMs(
  rpm: number,
  bufferMs = BUFFER_MS,
  windowMs = WINDOW_MS,
) {
  return Math.ceil(windowMs / pos(rpm)) + nonNeg(bufferMs);
}

export function dailyCap(rpd: number, thresholdPct = THRESHOLD_PCT) {
  return Math.ceil(pos(rpd) * (pct(thresholdPct) / 100));
}

export function tokenWaitMs(input: {
  used: number;
  tokens: number;
  limit: number;
  hits: readonly Hit[];
  now: number;
  windowMs?: number;
  bufferMs?: number;
}) {
  const limit = pos(input.limit);
  const tokens = nonNeg(input.tokens);
  const used = nonNeg(input.used);
  const windowMs = pos(input.windowMs ?? WINDOW_MS, WINDOW_MS);
  const bufferMs = nonNeg(input.bufferMs ?? BUFFER_MS, BUFFER_MS);
  const projected = used + tokens;

  if (tokens > limit) {
    return null;
  }

  if (projected <= limit) {
    return 0;
  }

  let remaining = projected;

  for (const hit of sortHits(input.hits)) {
    remaining -= nonNeg(hit.tokens);

    if (remaining <= limit) {
      return Math.max(0, windowMs - (input.now - hit.at) + bufferMs);
    }
  }

  return windowMs + bufferMs;
}
