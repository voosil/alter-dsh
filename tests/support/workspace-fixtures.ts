/**
 * Harness for the Space ↔ DSH workspace bridge.
 *
 * The bridge talks to two external authorities: the Space business service
 * (SQLite store) and the DSH workspace registry (a Host service). The harness
 * reuses the shared registry double from `tests/support/dsh-fakes.ts`, so every
 * test sees one definition of the DSH contract.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createSpaceAuthority } from '../../host/authority/compose.js';
import { openSpaceStore } from '../../host/persistence/store.js';
import {
  createSpaceWorkspaceSync,
  type SpaceWorkspaceSync,
} from '../../host/workspace/sync.js';
import type { SpaceService } from '@alter/protocol';
import { FIXED_NOW, tempDir } from './lifecycle.js';
import { FakeWorkspace, FakeWorkspaceRegistry } from './dsh-fakes.js';

export { FIXED_NOW, FakeWorkspace, FakeWorkspaceRegistry };

export interface SyncHarness {
  /** Root temporary directory (data lives under `root/data`). */
  readonly root: string;
  /** Fake home directory used to expand `~/…`. */
  readonly home: string;
  store: Awaited<ReturnType<typeof openSpaceStore>>;
  service: SpaceService;
  registry: FakeWorkspaceRegistry;
  sync: SpaceWorkspaceSync;
  /** Create a directory under the fake home and return its absolute path. */
  homeDir: (name: string) => Promise<string>;
  /** Create a directory anywhere under the temp root. */
  rootDir: (name: string) => Promise<string>;
  /** Close the store and remove the temp root. */
  cleanup: () => Promise<void>;
}

/** Build one isolated bridge harness. */
export async function createSyncHarness(): Promise<SyncHarness> {
  const root = await tempDir('alter-space-workspace-');
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const store = await openSpaceStore({
    directory: join(root, 'data'),
    now: FIXED_NOW,
  });
  const service = createSpaceAuthority(store, FIXED_NOW).user;
  const registry = new FakeWorkspaceRegistry();
  const sync = createSpaceWorkspaceSync({
    registry,
    store,
    homeDirectory: home,
    now: FIXED_NOW,
  });
  return {
    root,
    home,
    store,
    service,
    registry,
    sync,
    async homeDir(name: string) {
      const path = join(home, name);
      await mkdir(path, { recursive: true });
      return path;
    },
    async rootDir(name: string) {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      return path;
    },
    async cleanup() {
      await store.close();
    },
  };
}