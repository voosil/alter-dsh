/**
 * Side conversations (侧边对话): the 「已完成未读」 marker of a branch.
 *
 * DSH publishes one status record per Session — `running` plus
 * `completionUnread`, which is set when a generation the user was not
 * watching stops (the main view is the only acknowledging surface). A branch
 * lives in a right-sidebar tab instead, so DSH's flag alone would never clear:
 * the tab is not the main view. This tracker therefore keeps the *displayed*
 * unread set locally, seeded from DSH's flag and cleared by the two surfaces
 * that put the branch in front of the user — the history row's 「打开」 and the
 * tab body becoming visible. A later completion re-raises it, so the veteran
 * marker survives repeated runs.
 *
 * The DSH face is mirrored structurally (no runtime `@deepseek-ai/*` import);
 * an absent service yields an inert store that marks nothing rather than
 * guessing.
 */

/** One Session's UI status record, as `ctx.uiSession.sessionStatus` publishes it. */
export interface SideSessionStatusEntry {
  /** Latest known running state; absent until a baseline establishes it. */
  readonly running?: boolean;
  /** Whether a stop outside the main view still needs acknowledgement. */
  readonly completionUnread?: boolean;
}

/** Observable status map the tracker subscribes to (structural). */
export interface SideSessionStatusSource {
  getSnapshot(): ReadonlyMap<string, SideSessionStatusEntry>;
  /** Present on the client's observable snapshot; absent on a bare double. */
  subscribe?(listener: () => void): () => void;
}

/**
 * Branch sessions whose last completion has not been seen yet.
 *
 * `getSnapshot` returns a stable set that only changes when the answer does,
 * so it is safe as a `useSyncExternalStore` snapshot.
 */
export interface SideUnreadStore {
  getSnapshot(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
  /** Mark one branch as seen; unknown ids are ignored. */
  acknowledge(sessionId: string): void;
}

/** Inert store for a boot without the Session status service. */
const EMPTY_UNREAD: ReadonlySet<string> = new Set();

/** The tracker plus its teardown. */
export interface SideUnreadTracker extends SideUnreadStore {
  /** Drop the DSH subscription and every listener. */
  dispose(): void;
}

/**
 * Track unread completions for every Session the status service knows about.
 *
 * The set mirrors DSH's `completionUnread` until {@link SideUnreadStore.acknowledge}
 * removes one id; DSH lowering the flag also removes it, so the surface never
 * shows a marker the platform has already withdrawn.
 * @param source - DSH status map; absent yields an inert tracker.
 * @returns stable store with a disposer.
 */
export function createSideUnreadTracker(
  source: SideSessionStatusSource | undefined,
): SideUnreadTracker {
  const listeners = new Set<() => void>();
  const unread = new Set<string>();
  let snapshot: ReadonlySet<string> = EMPTY_UNREAD;
  let disposed = false;

  const publish = (): void => {
    snapshot = new Set(unread);
    for (const listener of listeners) listener();
  };

  const sync = (): void => {
    if (disposed || source === undefined) return;
    let changed = false;
    for (const [sessionId, status] of source.getSnapshot()) {
      const flagged = status.completionUnread === true;
      if (flagged && !unread.has(sessionId)) {
        unread.add(sessionId);
        changed = true;
      } else if (!flagged && unread.delete(sessionId)) {
        changed = true;
      }
    }
    if (changed) publish();
  };

  const unsubscribe = source?.subscribe?.(() => sync()) ?? (() => undefined);
  sync();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acknowledge(sessionId) {
      if (!unread.delete(sessionId)) return;
      publish();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      listeners.clear();
      unread.clear();
      snapshot = EMPTY_UNREAD;
    },
  };
}
