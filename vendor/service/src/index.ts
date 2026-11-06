import type { SpaceService } from '@alter/protocol';
import type { SpaceHubReader } from './contracts.js';
import { openSpaceStore } from './store.js';
import { createContentService } from './service.js';
import { createHubService } from './hub.js';

export interface CreateSpaceServiceOptions {
  /** Directory that owns the Space data file (host data directory). */
  directory: string;
  /** Business clock; tests inject a fixed clock. */
  now?: () => Date;
}

export type SpaceServiceHandle = SpaceService & { dispose(): Promise<void> };

/**
 * Open the persistent Space authority and compose the content and hub services.
 * One handle per host process; {@link SpaceServiceHandle.dispose} releases writes.
 */
export async function createSpaceService(
  options: CreateSpaceServiceOptions,
): Promise<SpaceServiceHandle> {
  const now = options.now ?? (() => new Date());
  const store = await openSpaceStore({ directory: options.directory, now });
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
  const service = createContentService({ store, hub, now });
  return Object.assign(service, { dispose: () => store.close() });
}

export type * from './contracts.js';
