/**
 * Reusable local Space runtime: the SQLite-backed authority, its business
 * services, document/asset sidecars, storage policy and snapshot scheduler.
 *
 * The DSH plugin and the standalone Space server compose the exact same
 * runtime; only the transport in front of it differs. Callers own the RPC and
 * asset routes and therefore register them outside this module.
 *
 * @module @alter-dsh/space/runtime
 */
import type { SpaceService } from '@alter/protocol';
import { createSpaceAuthority } from './authority.js';
import { createSnapshotScheduler } from './backup.js';
import {
  createDocumentAssets,
  type DocumentAssets,
} from './document/assets.js';
import { gcDocumentArtifacts } from './document/gc.js';
import { createStructuredSpaceService } from './document/notes.js';
import {
  createDocumentService,
  type DocumentService,
} from './document/service.js';
import { withVersionRetention } from './retention.js';
import { createSpaceStorage, type SpaceStorageApi } from './storage.js';
import {
  openSpaceStore,
  type SpaceStoreHandle,
  type SpaceStoreLogger,
} from './store.js';

/** One opened local authority plus its lifecycle-owned resources. */
export interface LocalSpaceRuntime {
  readonly kind: 'local';
  /** Data directory that owns `space.db` and `assets/`. */
  readonly directory: string;
  /** Raw store; callers that need persistence seams read it directly. */
  readonly store: SpaceStoreHandle;
  readonly service: SpaceService;
  readonly document: DocumentService;
  readonly assets: DocumentAssets;
  readonly storage: SpaceStorageApi;
  /** Close the snapshot scheduler and the database connection. */
  close(): Promise<void>;
}

export interface LocalRuntimeOptions {
  /** Data directory that owns `space.db` and `assets/`. */
  directory: string;
  /** Business clock; tests pin it. */
  now?: () => Date;
  logger?: SpaceStoreLogger;
  /** Start the daily snapshot scheduler; defaults to `true`. */
  snapshots?: boolean;
}

/** Format one caught error for a single warning line. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open one local authority and compose every service an RPC route or an Agent
 * tool needs. The caller must call {@link LocalSpaceRuntime.close} on unload.
 * @param options - data directory, clock, logger and snapshot switch.
 */
export async function createLocalSpaceRuntime(
  options: LocalRuntimeOptions,
): Promise<LocalSpaceRuntime> {
  const { directory } = options;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? {};
  const store = await openSpaceStore({ directory, now, logger });
  try {
    // The business service only sees a store that keeps version history
    // within the user's policy; the raw store keeps the persistence seams.
    const retainedStore = withVersionRetention(store, () =>
      store.getStorageSettings(),
    );
    const document = createDocumentService({ store, now });
    // Notes are AST-backed documents: creation and body writes go through the
    // document service while every other Space method delegates unchanged.
    const service = createStructuredSpaceService(
      createSpaceAuthority(retainedStore, now),
      document,
    );
    const storage = createSpaceStorage({ store, directory });
    const assets = createDocumentAssets({ store, directory, now });
    void gcDocumentArtifacts({ store, directory, logger }).catch(
      (error: unknown) => {
        logger.warn?.(
          `[alter-dsh-space] 文档对象/资产 GC 失败：${describeError(error)}`,
        );
      },
    );
    const snapshots =
      options.snapshots === false
        ? undefined
        : createSnapshotScheduler({ store, directory, now, logger });
    snapshots?.start();
    let closed: Promise<void> | undefined;
    return {
      kind: 'local',
      directory,
      store,
      service,
      document,
      assets,
      storage,
      close() {
        closed ??= (async () => {
          await snapshots?.dispose();
          await store.close();
        })();
        return closed;
      },
    };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
