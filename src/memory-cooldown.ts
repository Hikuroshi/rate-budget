import { toNonNegativeInteger } from "./limits.js";

export type ActorCooldownState = {
  lastAcceptedAt: number;
  lastActorId: string;
};

export type ActorCooldownDecision =
  | { allowed: true; state: ActorCooldownState }
  | {
      allowed: false;
      retryAfterMs: number;
      state: ActorCooldownState;
    };

export type ActorCooldownOptions = {
  sameActorCooldownMs: number;
  differentActorCooldownMs: number;
  stateTtlMs?: number;
  cleanupInterval?: number;
};

export function consumeActorCooldown(
  currentState: ActorCooldownState | null | undefined,
  input: {
    actorId: string;
    now?: number;
    sameActorCooldownMs: number;
    differentActorCooldownMs: number;
  },
): ActorCooldownDecision {
  const now = Number.isFinite(input.now) ? input.now ?? Date.now() : Date.now();

  if (!currentState) {
    return {
      allowed: true,
      state: {
        lastAcceptedAt: now,
        lastActorId: input.actorId,
      },
    };
  }

  const requiredCooldownMs =
    currentState.lastActorId === input.actorId
      ? toNonNegativeInteger(input.sameActorCooldownMs)
      : toNonNegativeInteger(input.differentActorCooldownMs);
  const elapsedMs = now - currentState.lastAcceptedAt;

  if (elapsedMs < requiredCooldownMs) {
    return {
      allowed: false,
      retryAfterMs: requiredCooldownMs - elapsedMs,
      state: currentState,
    };
  }

  return {
    allowed: true,
    state: {
      lastAcceptedAt: now,
      lastActorId: input.actorId,
    },
  };
}

export class InMemoryActorCooldownLimiter {
  private readonly states = new Map<string, ActorCooldownState>();
  private readonly sameActorCooldownMs: number;
  private readonly differentActorCooldownMs: number;
  private readonly stateTtlMs: number;
  private readonly cleanupInterval: number;
  private touches = 0;

  constructor(options: ActorCooldownOptions) {
    this.sameActorCooldownMs = toNonNegativeInteger(options.sameActorCooldownMs);
    this.differentActorCooldownMs = toNonNegativeInteger(
      options.differentActorCooldownMs,
    );
    this.stateTtlMs = toNonNegativeInteger(options.stateTtlMs ?? 5 * 60_000);
    this.cleanupInterval = Math.max(
      1,
      toNonNegativeInteger(options.cleanupInterval ?? 256, 256),
    );
  }

  consume(scopeId: string, actorId: string, now = Date.now()) {
    this.cleanup(now);

    const decision = consumeActorCooldown(this.states.get(scopeId), {
      actorId,
      now,
      sameActorCooldownMs: this.sameActorCooldownMs,
      differentActorCooldownMs: this.differentActorCooldownMs,
    });

    if (decision.allowed) {
      this.states.set(scopeId, decision.state);
    }

    return decision;
  }

  reset(scopeId?: string) {
    if (scopeId) {
      this.states.delete(scopeId);
      return;
    }

    this.states.clear();
  }

  size() {
    return this.states.size;
  }

  private cleanup(now: number) {
    this.touches += 1;

    if (this.touches % this.cleanupInterval !== 0) {
      return;
    }

    for (const [scopeId, state] of this.states.entries()) {
      if (now - state.lastAcceptedAt > this.stateTtlMs) {
        this.states.delete(scopeId);
      }
    }
  }
}
