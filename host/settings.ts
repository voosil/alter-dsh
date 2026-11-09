/**
 * Storage policy shared by the Host persistence layer.
 *
 * The policy is small on purpose: document version history keeps at most one
 * full copy per recorded edit up to a per-document count/byte budget, and the
 * daily whole-database snapshot keeps a bounded ring. Both numbers are user
 * settings persisted in the SQLite `meta` table.
 *
 * Keep this module free of Runtime imports (no `node:fs`, no `./store.js`) so
 * the store and the storage controller can both depend on it without cycles.
 */

/** User-tunable storage policy, persisted as JSON in the `meta` table. */
export interface StorageSettings {
  /** Maximum number of document versions kept per document. */
  historyLimit: number;
  /** Maximum number of daily whole-database snapshots kept on disk. */
  snapshotKeep: number;
}

/** Factory defaults: 10 versions per document, 3 daily snapshots. */
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  historyLimit: 10,
  snapshotKeep: 3,
};

/** Inclusive bounds; the RPC layer rejects anything outside them. */
export const STORAGE_LIMITS = {
  historyLimit: { min: 1, max: 100 },
  snapshotKeep: { min: 1, max: 30 },
} as const;

/** Per-document byte budget for version history (in addition to the count). */
export const HISTORY_BYTE_BUDGET = 64 * 1024;

/** Conservative whole-snapshot compression ratio used for footprint estimates. */
export const SNAPSHOT_COMPRESSION_RATIO = 8;

/** `meta` row that stores the JSON policy. */
export const STORAGE_SETTINGS_KEY = 'settings:storage';

/** Bound on the SQLite WAL high-water mark after checkpoints. */
export const WAL_SIZE_LIMIT = 16 * 1024 * 1024;

function integerInRange(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

/**
 * Normalize a partial/unknown settings value into the accepted shape.
 * Missing or invalid fields fall back to the defaults.
 */
export function clampStorageSettings(
  value: Partial<StorageSettings> | undefined,
): StorageSettings {
  return {
    historyLimit:
      integerInRange(
        value?.historyLimit,
        STORAGE_LIMITS.historyLimit.min,
        STORAGE_LIMITS.historyLimit.max,
      ) ?? DEFAULT_STORAGE_SETTINGS.historyLimit,
    snapshotKeep:
      integerInRange(
        value?.snapshotKeep,
        STORAGE_LIMITS.snapshotKeep.min,
        STORAGE_LIMITS.snapshotKeep.max,
      ) ?? DEFAULT_STORAGE_SETTINGS.snapshotKeep,
  };
}

/** Parse the persisted `meta` value; corrupt or missing settings use defaults. */
export function parseStorageSettings(raw: string | undefined): StorageSettings {
  if (typeof raw !== 'string' || raw.length === 0)
    return { ...DEFAULT_STORAGE_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { ...DEFAULT_STORAGE_SETTINGS };
    return clampStorageSettings(parsed as Partial<StorageSettings>);
  } catch {
    return { ...DEFAULT_STORAGE_SETTINGS };
  }
}
