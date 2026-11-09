/**
 * Storage settings + footprint estimate.
 *
 * The settings themselves live in the SQLite `meta` table (owned by the
 * store); this module is the Host-side controller the RPC layer talks to:
 * read the policy, project disk usage for a candidate policy from the *current*
 * data, and persist a change while applying it immediately (trim version
 * history, prune extra snapshots).
 *
 * The estimate is deliberately a simple upper bound, not a forecast of future
 * edits: each document is assumed to reach its version cap, and the whole
 * database is assumed to be duplicated by the retained snapshots at a
 * conservative compression ratio. That keeps the settings UI honest about the
 * worst case while still being cheap to compute (one pass over the in-memory
 * data plus a few `stat` calls).
 */
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { backupsDirectory, pruneSnapshots, snapshotBytes } from './backup.js';
import { trimAllVersions } from './retention.js';
import {
  HISTORY_BYTE_BUDGET,
  SNAPSHOT_COMPRESSION_RATIO,
  clampStorageSettings,
  type StorageSettings,
} from './settings.js';
import type { SpaceStoreHandle } from './store.js';

/** Estimated disk footprint for one policy, in bytes. */
export interface StorageEstimate {
  /** Documents that currently exist (kind = note, not in the trash). */
  documentCount: number;
  /** Average serialized document size in bytes. */
  averageDocumentBytes: number;
  /** Current on-disk footprint: database + WAL + existing snapshots. */
  currentBytes: number;
  currentMainBytes: number;
  currentSnapshotBytes: number;
  currentWalBytes: number;
  /** Upper bound the data can grow to under the policy. */
  projectedBytes: number;
  projectedMainBytes: number;
  projectedSnapshotBytes: number;
  /** `projectedBytes - currentBytes` (negative when the policy shrinks). */
  deltaBytes: number;
}

/** Settings plus the estimate for exactly those settings. */
export interface StorageState {
  settings: StorageSettings;
  estimate: StorageEstimate;
}

/** Host-side storage API consumed by the RPC dispatch. */
export interface SpaceStorageApi {
  /** Current policy and its estimate. */
  get(): Promise<StorageState>;
  /** Estimate for a candidate policy without persisting it. */
  estimate(patch: Partial<StorageSettings>): Promise<StorageEstimate>;
  /** Persist a policy and apply it to existing data. */
  set(patch: Partial<StorageSettings>): Promise<StorageState>;
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function computeEstimate(
  store: SpaceStoreHandle,
  directory: string,
  settings: StorageSettings,
): Promise<StorageEstimate> {
  const data = store.read();
  const documents = data.nodes.filter(
    (node) => node.kind === 'note' && !node.deletedAt,
  );
  let documentBytes = 0;
  const documentSizes: number[] = [];
  for (const document of documents) {
    const size = serializedBytes(document);
    documentSizes.push(size);
    documentBytes += size;
  }
  let versionBytes = 0;
  for (const version of data.versions) versionBytes += serializedBytes(version);

  const mainBytes = await fileSize(store.file);
  const walBytes = await fileSize(`${store.file}-wal`);
  const snapshotsBytes = await snapshotBytes(directory);

  // Everything in the database that is not document body or version history
  // (other collections, order arrays, row overhead).
  const otherBytes = Math.max(0, mainBytes - documentBytes - versionBytes);
  const historyBytes = documentSizes.reduce(
    (sum, size) =>
      sum + Math.min(settings.historyLimit * size, HISTORY_BYTE_BUDGET),
    0,
  );
  const projectedMainBytes = otherBytes + documentBytes + historyBytes;
  const projectedSnapshotBytes = Math.round(
    (settings.snapshotKeep * projectedMainBytes) / SNAPSHOT_COMPRESSION_RATIO,
  );
  const currentBytes = mainBytes + walBytes + snapshotsBytes;
  const projectedBytes = projectedMainBytes + projectedSnapshotBytes + walBytes;
  return {
    documentCount: documents.length,
    averageDocumentBytes:
      documents.length === 0
        ? 0
        : Math.round(documentBytes / documents.length),
    currentBytes,
    currentMainBytes: mainBytes,
    currentSnapshotBytes: snapshotsBytes,
    currentWalBytes: walBytes,
    projectedBytes,
    projectedMainBytes,
    projectedSnapshotBytes,
    deltaBytes: projectedBytes - currentBytes,
  };
}

/**
 * Build the storage controller for one opened authority.
 * @param options - opened store and the data directory it lives in.
 */
export function createSpaceStorage(options: {
  store: SpaceStoreHandle;
  directory: string;
}): SpaceStorageApi {
  const { store, directory } = options;
  const backups = backupsDirectory(directory);

  async function get(): Promise<StorageState> {
    const settings = store.getStorageSettings();
    return { settings, estimate: await computeEstimate(store, directory, settings) };
  }

  return {
    get,
    estimate(patch) {
      const settings = clampStorageSettings({
        ...store.getStorageSettings(),
        ...patch,
      });
      return computeEstimate(store, directory, settings);
    },
    async set(patch) {
      const previous = store.getStorageSettings();
      const next = clampStorageSettings({ ...previous, ...patch });
      await store.setStorageSettings(next);
      // A lowered limit must apply to history that already exists.
      await store.update((data) => {
        trimAllVersions(data, next);
      });
      if (next.snapshotKeep !== previous.snapshotKeep)
        await pruneSnapshots(backups, next.snapshotKeep).catch(() => undefined);
      return get();
    },
  };
}

/** Directory that owns the database file; convenience for callers. */
export function dataDirectoryOf(store: SpaceStoreHandle): string {
  return dirname(store.file);
}
