/**
 * Test fixtures for the Space ↔ DSH workspace bridge.
 *
 * The bridge talks to two external authorities: the Space business service
 * (SQLite store) and the DSH workspace registry (a Host service). Tests use
 * the real Space authority over a temporary SQLite database and an in-memory
 * registry double, so the bridge logic runs unmodified.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpaceAuthority } from '../host/authority.js';
import { openSpaceStore } from '../host/store.js';
import {
  createSpaceWorkspaceSync,
  type SpaceWorkspaceSync,
  type WorkspaceEntityLike,
  type WorkspaceRegistryLike,
} from '../host/workspace-sync.js';
import type { SpaceService } from '@alter/protocol';

/** Fixed business clock shared by fixtures and assertions. */
export const FIXED_NOW = () => new Date('2026-11-09T00:00:00.000Z');

/** In-memory DSH workspace entity. */
export class FakeWorkspace implements WorkspaceEntityLike {
  readonly id: string;
  readonly path: string;
  readonly sessionIds: string[];
  title: string;

  constructor(
    id: string,
    path: string,
    title: string,
    sessionIds: string[] = [],
  ) {
    this.id = id;
    this.path = path;
    this.title = title;
    this.sessionIds = sessionIds;
  }

  async setTitle(title: string): Promise<void> {
    this.title = title;
  }
}

/** In-memory DSH workspace registry with the bridge's Host-service contract. */
export class FakeWorkspaceRegistry implements WorkspaceRegistryLike {
  private sequence = 0;
  readonly byId = new Map<string, FakeWorkspace>();

  /** Register a workspace directly, as DSH's native creation flow would. */
  seed(path: string, title: string, sessionIds: string[] = []): FakeWorkspace {
    const entity = new FakeWorkspace(`ws-${++this.sequence}`, path, title, sessionIds);
    this.byId.set(entity.id, entity);
    return entity;
  }

  async create(path: string, title?: string): Promise<FakeWorkspace> {
    const existing = this.list().find((workspace) => workspace.path === path);
    if (existing !== undefined) return existing as FakeWorkspace;
    const fallback = path.split('/').filter(Boolean).pop() ?? path;
    return this.seed(path, title ?? fallback);
  }

  get(id: string): FakeWorkspace | undefined {
    return this.byId.get(id);
  }

  list(): FakeWorkspace[] {
    return [...this.byId.values()];
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async resolveByPath(path: string): Promise<FakeWorkspace | undefined> {
    return this.list().find((workspace) => workspace.path === path);
  }
}

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
  cleanup: () => Promise<void>;
}

/** Build one isolated bridge harness. */
export async function createSyncHarness(): Promise<SyncHarness> {
  const root = await mkdtemp(join(tmpdir(), 'alter-space-workspace-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const store = await openSpaceStore({
    directory: join(root, 'data'),
    now: FIXED_NOW,
  });
  const service = createSpaceAuthority(store, FIXED_NOW);
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
      await rm(root, { recursive: true, force: true });
    },
  };
}
