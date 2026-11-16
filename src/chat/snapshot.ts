/**
 * Minimal observable snapshot store (same shape as the host runtime's
 * client-store): an immutable value plus subscribe, for `useSyncExternalStore`.
 */

export interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export function createSnapshotStore<T>(initial: T): ObservableSnapshot<T> & {
  set(next: T): void;
} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
