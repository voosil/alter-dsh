/**
 * Compose the Space business services over the local store.
 *
 * One authority, two entrances: the user stack speaks for the browser and the
 * alter stack for Agent tool ports. Each stack binds its write identity at
 * construction — services derive every attribution field from it, and the
 * scoped store enforces the same identity inside each persistence transaction.
 * Callers select a stack; they never pass per-call identities.
 *
 * Takes an already opened {@link SpaceStoreHandle} so the Host owns the SQLite
 * lifecycle.
 */
import type {
  SpaceHubReader,
  SpaceStore,
  SpaceStoreData,
} from '../../vendor/service/src/contracts.js';
import type { SpaceActor, SpaceService } from '@alter/protocol';
import { createHubService } from '../../vendor/service/src/hub.js';
import { createContentService } from '../../vendor/service/src/service.js';
import { withVersionRetention } from '../persistence/retention.js';
import type { SpaceStoreHandle } from '../persistence/store.js';

/** The two write-identity stacks over one shared authority. */
export interface SpaceAuthorityStacks {
  /** Browser-facing stack: attribution derives from `user`. */
  user: SpaceService;
  /** Agent-facing stack: attribution derives from `alter`. */
  alter: SpaceService;
}

/**
 * Build the content + hub services for both write identities over `store`.
 * @param store - opened persistent store; the caller owns its lifecycle.
 * @param now - business clock (tests pin it).
 */
export function createSpaceAuthority(
  store: SpaceStoreHandle,
  now: () => Date,
): SpaceAuthorityStacks {
  const reader: SpaceHubReader = {
    space(id) {
      const space = store.read().spaces.find((item) => item.id === id);
      if (!space) throw new Error('空间不存在');
      return space;
    },
    nodes: (id) => store.read().nodes.filter((item) => item.spaceId === id),
    thoughts: (id) =>
      store.read().thoughts.filter((item) => item.spaceId === id),
    events: (id) => store.read().events.filter((item) => item.spaceId === id),
  };
  const build = (actor: SpaceActor): SpaceService => {
    // Every business write runs under the stack's identity; the persistence
    // guard checks the same identity in the same transaction.
    const scoped: SpaceStore = {
      read: () => store.read(),
      update: <T>(change: (data: SpaceStoreData) => T) =>
        store.updateAs(actor, change),
      close: () => store.close(),
    };
    // The business service only sees a store that keeps version history
    // within the user's policy; the raw store keeps the persistence seams.
    const retained = withVersionRetention(scoped, () =>
      store.getStorageSettings(),
    );
    const hub = createHubService({ store: retained, reader, now, actor });
    return createContentService({ store: retained, hub, now, actor });
  };
  return { user: build('user'), alter: build('alter') };
}