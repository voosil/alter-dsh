/**
 * Compose the Space business services over the local store.
 *
 * Takes an already opened {@link SpaceStore} so the Host owns the SQLite
 * lifecycle.
 */
import type { SpaceHubReader } from '../vendor/service/src/contracts.js';
import type { SpaceStore } from '../vendor/service/src/contracts.js';
import type { SpaceService } from '@alter/protocol';
import { createHubService } from '../vendor/service/src/hub.js';
import { createContentService } from '../vendor/service/src/service.js';

export interface SpaceAuthority {
  service: SpaceService;
}

/**
 * Build the content + hub services over `store`.
 * @param store - opened persistent store; the caller owns its lifecycle.
 * @param now - business clock (tests pin it).
 */
export function createSpaceAuthority(
  store: SpaceStore,
  now: () => Date,
): SpaceService {
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
  const hub = createHubService({ store, reader, now });
  return createContentService({ store, hub, now });
}
