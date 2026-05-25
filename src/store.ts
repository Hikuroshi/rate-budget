import { emptyState } from "./internal.js";
import type { QuotaState, QuotaStore } from "./types.js";

export class MemoryStore implements QuotaStore {
  private readonly scopes = new Map<string, QuotaState>();

  mutate<T>(scope: string, fn: (state: QuotaState) => T) {
    const state = this.scopes.get(scope) ?? emptyState();
    const result = fn(state);
    this.scopes.set(scope, state);

    return result;
  }

  get(scope: string) {
    return this.scopes.get(scope);
  }

  set(scope: string, state: QuotaState) {
    this.scopes.set(scope, state);
  }

  reset(scope?: string) {
    if (scope) {
      this.scopes.delete(scope);
      return;
    }

    this.scopes.clear();
  }

  size() {
    return this.scopes.size;
  }
}
