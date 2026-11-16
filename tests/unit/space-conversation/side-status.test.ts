// @vitest-environment node
/**
 * Unread tracker over DSH's Session status map.
 *
 * The tracker owns the 「已完成」 marker a branch keeps until the user opens it:
 * it seeds from DSH's `completionUnread`, clears on acknowledgement and on DSH
 * withdrawing the flag, and re-raises on the next completion. A boot without
 * the service must stay inert instead of guessing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSideUnreadTracker,
  type SideSessionStatusEntry,
} from '../../../src/space-conversation/side-status';

/** Controllable status source: one Map and a listener roster. */
function statusDouble(initial: Record<string, SideSessionStatusEntry>) {
  const entries = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  return {
    entries,
    source: {
      getSnapshot: () => entries,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    /** Replace the published map and notify, like the DSH observable does. */
    publish(next: Record<string, SideSessionStatusEntry>) {
      entries.clear();
      for (const [id, status] of Object.entries(next)) entries.set(id, status);
      for (const listener of listeners) listener();
    },
  };
}

describe('createSideUnreadTracker', () => {
  it('seeds from the status map and marks only flagged sessions', () => {
    const status = statusDouble({
      'sess-a': { running: false, completionUnread: true },
      'sess-b': { running: false, completionUnread: false },
      'sess-c': { running: true, completionUnread: false },
    });
    const tracker = createSideUnreadTracker(status.source);
    expect([...tracker.getSnapshot()]).toEqual(['sess-a']);
    tracker.dispose();
  });

  it('follows later publications', () => {
    const status = statusDouble({ 'sess-a': { running: true, completionUnread: false } });
    const tracker = createSideUnreadTracker(status.source);
    const listener = vi.fn();
    tracker.subscribe(listener);
    status.publish({ 'sess-a': { running: false, completionUnread: true } });
    expect(tracker.getSnapshot().has('sess-a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // A withdrawn flag (the main view acknowledged it) clears the marker too.
    status.publish({ 'sess-a': { running: false, completionUnread: false } });
    expect(tracker.getSnapshot().has('sess-a')).toBe(false);
    tracker.dispose();
  });

  it('clears on acknowledge and re-raises on the next completion', () => {
    const status = statusDouble({ 'sess-a': { running: false, completionUnread: true } });
    const tracker = createSideUnreadTracker(status.source);
    tracker.acknowledge('sess-a');
    expect(tracker.getSnapshot().has('sess-a')).toBe(false);
    status.publish({ 'sess-a': { running: true, completionUnread: false } });
    status.publish({ 'sess-a': { running: false, completionUnread: true } });
    expect(tracker.getSnapshot().has('sess-a')).toBe(true);
    tracker.dispose();
  });

  it('keeps a stable snapshot between changes and notifies once per change', () => {
    const status = statusDouble({ 'sess-a': { running: false, completionUnread: true } });
    const tracker = createSideUnreadTracker(status.source);
    const before = tracker.getSnapshot();
    expect(tracker.getSnapshot()).toBe(before);
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.acknowledge('sess-a');
    const after = tracker.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.has('sess-a')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    // Acknowledging an unknown id is not a change.
    tracker.acknowledge('sess-missing');
    expect(tracker.getSnapshot()).toBe(after);
    expect(listener).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('stops following the source after disposal', () => {
    const status = statusDouble({ 'sess-a': { running: true, completionUnread: false } });
    const tracker = createSideUnreadTracker(status.source);
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.dispose();
    status.publish({ 'sess-a': { running: false, completionUnread: true } });
    expect(tracker.getSnapshot().size).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stays inert without the service', () => {
    const tracker = createSideUnreadTracker(undefined);
    expect(tracker.getSnapshot().size).toBe(0);
    expect(() => tracker.acknowledge('sess-a')).not.toThrow();
    expect(tracker.getSnapshot().size).toBe(0);
    tracker.dispose();
  });
});
