/**
 * Real Space server and authority harnesses.
 *
 * Integration tests exercise the same runtime the plugin boots: a real SQLite
 * file, the real HTTP listener, real bearer-token authentication. Nothing here
 * stubs the authority; the only double is the logger.
 */
import { startSpaceServer, type RunningSpaceServer } from '../../server/core/index.js';
import { createLocalSpaceRuntime, type LocalSpaceRuntime } from '../../host/core/runtime.js';
import { createSpaceAuthority } from '../../host/authority/compose.js';
import { createSpaceStorage, type SpaceStorageApi } from '../../host/persistence/storage.js';
import { createDocumentService, type DocumentService } from '../../host/document/editors/legacy/service.js';
import { createStructuredSpaceService } from '../../host/document/editors/legacy/notes.js';
import { openSpaceStore, type SpaceStoreHandle } from '../../host/persistence/store.js';
import type { SpaceService } from '@alter/protocol';
import { FIXED_NOW, dispose, quietLogger, subDir, tempDir } from './lifecycle.js';

/** Bearer token every harness server accepts. */
export const TEST_TOKEN = '0123456789abcdef0123456789abcdef';

export interface SpaceServerHandle extends RunningSpaceServer {
  /** Directory that owns the server's SQLite file. */
  readonly dataDir: string;
}

/**
 * Start the real standalone server on a random loopback port.
 * @param options.dataDir - reuse an existing directory (defaults to a temp dir).
 */
export async function startTestServer(options: { dataDir?: string } = {}): Promise<SpaceServerHandle> {
  const dataDir = options.dataDir ?? (await tempDir('space-server-'));
  const server = await startSpaceServer(
    {
      dataDir,
      host: '127.0.0.1',
      port: 0,
      tokens: [{ label: 'test', token: TEST_TOKEN }],
      snapshots: false,
    },
    quietLogger(),
  );
  dispose(() => server.close());
  return { ...server, dataDir };
}

/** A local runtime that owns a temp data directory and closes automatically. */
export interface TestRuntime {
  readonly runtime: LocalSpaceRuntime;
  readonly directory: string;
}

/**
 * Open a local authority runtime over a fresh (or reused) temp directory.
 * @param options.directory - reuse an existing directory.
 * @param options.snapshots - start the daily snapshot scheduler.
 */
export async function startRuntime(
  options: { directory?: string; snapshots?: boolean } = {},
): Promise<TestRuntime> {
  const directory = options.directory ?? (await tempDir('space-runtime-'));
  const runtime = await createLocalSpaceRuntime({
    directory,
    logger: quietLogger(),
    snapshots: options.snapshots ?? false,
  });
  dispose(() => runtime.close());
  return { runtime, directory };
}

/** One space plus its document service, composed exactly as the Host composes it. */
export interface TestAuthority {
  readonly directory: string;
  readonly store: SpaceStoreHandle;
  /** User-identity stack (browser entrance). */
  readonly service: SpaceService;
  /** Alter-identity stack (Agent entrance), same authority. */
  readonly agentService: SpaceService;
  /** User-identity document service. */
  readonly document: DocumentService;
  /** Alter-identity document service. */
  readonly agentDocument: DocumentService;
  readonly storage: SpaceStorageApi;
}

/**
 * Open the Space business authority plus the document sidecar over a store.
 * @param options.directory - reuse an existing directory.
 * @param options.now - business clock (defaults to the fixed test clock).
 */
export async function startAuthority(
  options: { directory?: string; now?: () => Date } = {},
): Promise<TestAuthority> {
  const directory = options.directory ?? (await tempDir('space-authority-'));
  const now = options.now ?? FIXED_NOW;
  const store = await openSpaceStore({ directory, now });
  dispose(() => store.close());
  const stacks = createSpaceAuthority(store, now);
  const document = createDocumentService({ store, now, actor: 'user' });
  const agentDocument = createDocumentService({ store, now, actor: 'alter' });
  const service = createStructuredSpaceService(stacks.user, document);
  const agentService = createStructuredSpaceService(stacks.alter, agentDocument);
  const storage = createSpaceStorage({ store, directory });
  return { directory, store, service, agentService, document, agentDocument, storage };
}

/** Seed one space with a small AST document; returns both ids. */
export async function seedSpaceWithDocument(
  authority: TestAuthority,
  name = '种子空间',
): Promise<{ spaceId: string; docId: string }> {
  const space = await authority.service.createSpace({ name, directories: [] });
  const generated = await authority.document.generate({
    spaceId: space.id,
    title: '种子文档',
    markdown: '# 标题\n\n正文',
  });
  return { spaceId: space.id, docId: generated.docId };
}

/**
 * Seed a local data directory through a runtime, then close it.
 *
 * Used by migration tests: the data must be on disk before the migration
 * service takes ownership of the authority.
 * @param directory - data directory to seed.
 * @param name - Space name to create.
 */
export async function seedDataDirectory(directory: string, name = '服务迁移'): Promise<string> {
  const runtime = await createLocalSpaceRuntime({
    directory,
    logger: quietLogger(),
    snapshots: false,
  });
  try {
    const space = await runtime.service.createSpace({ name, directories: [] });
    await runtime.document.generate({
      spaceId: space.id,
      title: '迁移文档',
      markdown: '# 标题\n\n正文',
    });
    return space.id;
  } finally {
    await runtime.close();
  }
}

/** Poll a migration job until it settles; returns the terminal status. */
export async function waitForMigration(
  status: () => { status: string },
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = status().status;
    if (state === 'done' || state === 'failed' || state === 'cancelled') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('migration did not settle');
}

/** Create a directory beside a temp root (helper for workspace paths). */
export async function workspaceDir(root: string, name: string): Promise<string> {
  return subDir(root, name);
}