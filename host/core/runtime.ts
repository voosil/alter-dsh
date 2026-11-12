/**
 * Reusable local Space runtime: the SQLite-backed authority, its business
 * services, document/asset sidecars, storage policy and snapshot scheduler.
 *
 * The DSH plugin and the standalone Space server compose the exact same
 * runtime; only the transport in front of it differs. Callers own the RPC and
 * asset routes and therefore register them outside this module.
 *
 * @module @alter-dsh/space/core/runtime
 */
import type { SpaceService } from '@alter/protocol';
import { createSpaceAuthority } from '../authority/compose.js';
import {
  createSnapshotScheduler,
  forceDailySnapshot,
  type SnapshotOutcome,
} from '../persistence/backup.js';
import {
  createDocumentAssets,
  type DocumentAssets,
} from '../document/asset-store.js';
import { gcDocumentArtifacts } from '../document/gc.js';
import { createStructuredSpaceService } from '../document/editors/legacy/notes.js';
import {
  createDocumentService,
  type DocumentService,
} from '../document/editors/legacy/service.js';
import { createSpaceStorage, type SpaceStorageApi } from '../persistence/storage.js';
import {
  openSpaceStore,
  type SpaceStoreHandle,
  type SpaceStoreLogger,
} from '../persistence/store.js';

/** One opened local authority plus its lifecycle-owned resources. */
export interface LocalSpaceRuntime {
  readonly kind: 'local';
  /** Data directory that owns `space.db` and `assets/`. */
  readonly directory: string;
  /** Raw store; callers that need persistence seams read it directly. */
  readonly store: SpaceStoreHandle;
  /** User-identity stack: the browser RPC entrance. */
  readonly service: SpaceService;
  /** Alter-identity stack: the Agent tool entrance (same authority). */
  readonly agentService: SpaceService;
  /** User-identity document service for the browser RPC. */
  readonly document: DocumentService;
  /** Alter-identity document service for Agent tool ports. */
  readonly agentDocument: DocumentService;
  readonly assets: DocumentAssets;
  readonly storage: SpaceStorageApi;
  /**
   * Snapshot the current data even when today already has one.
   *
   * Used after a migration replaces the database: the target needs an initial
   * snapshot of the new data, but the day may already hold one of the old data.
   */
  snapshotNow(): Promise<SnapshotOutcome>;
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
    // One authority, two write-identity stacks; each stack's store enforces
    // its identity inside every persistence transaction (version retention
    // is applied per stack by the composer).
    const stacks = createSpaceAuthority(store, now);
    const document = createDocumentService({ store, now, actor: 'user' });
    const agentDocument = createDocumentService({ store, now, actor: 'alter' });
    // Notes are AST-backed documents: creation and body writes go through the
    // document service while every other Space method delegates unchanged.
    const service = createStructuredSpaceService(stacks.user, document);
    const agentService = createStructuredSpaceService(stacks.alter, agentDocument);
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
      agentService,
      document,
      agentDocument,
      assets,
      storage,
      snapshotNow() {
        if (snapshots !== undefined) return snapshots.forceRunNow();
        return forceDailySnapshot({ store, directory, now, logger });
      },
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
