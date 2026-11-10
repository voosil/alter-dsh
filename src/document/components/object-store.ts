/**
 * In-memory cache of component object payloads used by node-view previews.
 *
 * The editor surface owns the RPC client, so it fetches missing objects
 * (`client.getObject`) and writes the result here. Node views subscribe with
 * `useSyncExternalStore`, so a late fetch re-renders the preview without
 * recreating the Tiptap node or the editor.
 *
 * Objects are immutable, so cached entries never go stale: a props update
 * creates a new `obj_…`, and the reloaded block references it (cache miss →
 * fresh fetch).
 *
 * @module @alter-dsh/space/document/components/object-store
 */
import { useSyncExternalStore } from 'react';
import type { ComponentPayload } from '@alter/protocol';

/** Load state of one component object referenced by a block. */
export type ComponentObjectState =
  | { status: 'loading' }
  | { status: 'ready'; payload: ComponentPayload }
  | { status: 'error'; message: string };

const states = new Map<string, ComponentObjectState>();
const listeners = new Set<() => void>();

/** Current cached state of one object id, if it has been requested. */
export function getComponentObjectState(
  objectId: string,
): ComponentObjectState | undefined {
  return states.get(objectId);
}

/** Store one load state and notify every subscribed node view. */
export function setComponentObjectState(
  objectId: string,
  state: ComponentObjectState,
): void {
  states.set(objectId, state);
  for (const listener of listeners) listener();
}

/** Subscribe to any object-state change (used by node views). */
export function subscribeComponentObjectStates(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop every cached state (document switch / test isolation). */
export function clearComponentObjectStates(): void {
  states.clear();
  for (const listener of listeners) listener();
}

/** Subscribe one node view to the cached state of its object id. */
export function useComponentObjectState(
  objectId: string | undefined,
): ComponentObjectState | undefined {
  return useSyncExternalStore(
    subscribeComponentObjectStates,
    () =>
      objectId === undefined ? undefined : getComponentObjectState(objectId),
  );
}
