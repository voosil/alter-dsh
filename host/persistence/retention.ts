/**
 * Bounded document-version history.
 *
 * The business service appends one full-content version per recorded
 * edit (at most one per document per five minutes) and never prunes. The Host
 * wraps the store it hands to that service: after a write that appended
 * versions, only the affected documents are trimmed to the user's policy
 * (version count + per-document byte budget). Both caps are enforced from the
 * oldest version forward, so the newest versions always survive.
 *
 * Trimming happens inside the same store transaction as the business write,
 * which keeps disk usage bounded without a background job.
 */
import type {
  SpaceStore,
  SpaceStoreData,
} from '../../vendor/service/src/contracts.js';
import { HISTORY_BYTE_BUDGET, type StorageSettings } from './settings.js';

type Version = SpaceStoreData['versions'][number];

function versionBytes(version: Version): number {
  return Buffer.byteLength(JSON.stringify(version), 'utf8');
}

function versionTime(version: Version): number {
  const parsed = Date.parse(version.at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Indices to drop so one document keeps at most `limit` versions / `budget`. */
function trimIndices(
  versions: Version[],
  indices: number[],
  settings: StorageSettings,
  drop: Set<number>,
): void {
  if (indices.length <= settings.historyLimit) {
    let bytes = 0;
    for (const index of indices) bytes += versionBytes(versions[index]);
    if (bytes <= HISTORY_BYTE_BUDGET) return;
  }
  // Newest first; ties prefer the later array position (most recently appended).
  const ordered = [...indices].sort(
    (a, b) => versionTime(versions[b]) - versionTime(versions[a]) || b - a,
  );
  let kept = 0;
  let keptBytes = 0;
  for (const index of ordered) {
    const bytes = versionBytes(versions[index]);
    const fits =
      kept < settings.historyLimit && keptBytes + bytes <= HISTORY_BYTE_BUDGET;
    // Never drop the newest version even if it alone exceeds the byte budget.
    if (fits || kept === 0) {
      kept += 1;
      keptBytes += bytes;
      continue;
    }
    drop.add(index);
  }
}

/**
 * Trim every document's history to `settings`.
 * Used when the policy changes, so a lowered limit applies immediately.
 */
export function trimAllVersions(
  data: SpaceStoreData,
  settings: StorageSettings,
): void {
  const byDoc = new Map<string, number[]>();
  data.versions.forEach((version, index) => {
    const indices = byDoc.get(version.docId) ?? [];
    indices.push(index);
    byDoc.set(version.docId, indices);
  });
  const drop = new Set<number>();
  for (const indices of byDoc.values())
    trimIndices(data.versions, indices, settings, drop);
  if (drop.size === 0) return;
  data.versions = data.versions.filter((_, index) => !drop.has(index));
}

/**
 * Trim only the documents that received a version in the write that just
 * finished. Callers pass the pre-write length; the service only appends (`recordVersion` → `push`), so the new versions are the tail.
 */
export function trimTouchedVersions(
  data: SpaceStoreData,
  previousLength: number,
  settings: StorageSettings,
): void {
  const touched = new Set<string>();
  for (let index = previousLength; index < data.versions.length; index += 1)
    touched.add(data.versions[index].docId);
  if (touched.size === 0) return;
  const indicesByDoc = new Map<string, number[]>();
  data.versions.forEach((version, index) => {
    if (!touched.has(version.docId)) return;
    const indices = indicesByDoc.get(version.docId) ?? [];
    indices.push(index);
    indicesByDoc.set(version.docId, indices);
  });
  const drop = new Set<number>();
  for (const indices of indicesByDoc.values())
    trimIndices(data.versions, indices, settings, drop);
  if (drop.size === 0) return;
  data.versions = data.versions.filter((_, index) => !drop.has(index));
}

/**
 * Wrap a store so every write that recorded a document version trims that
 * document's history to the current policy before the transaction commits.
 */
export function withVersionRetention(
  store: SpaceStore,
  getSettings: () => StorageSettings,
): SpaceStore {
  return {
    read: () => store.read(),
    close: () => store.close(),
    update<T>(change: (data: SpaceStoreData) => T): Promise<T> {
      return store.update((data) => {
        const previousLength = data.versions.length;
        const result = change(data);
        if (data.versions.length > previousLength)
          trimTouchedVersions(data, previousLength, getSettings());
        return result;
      });
    },
  };
}
