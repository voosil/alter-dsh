/**
 * Daily whole-database snapshots.
 *
 * One snapshot per calendar day: `VACUUM INTO` produces a consistent,
 * defragmented copy of the live SQLite database (including committed WAL
 * content) without stopping the Host, then the copy is gzip-compressed and
 * atomically renamed into `backups/space-YYYYMMDD.db.gz`. Old snapshots
 * beyond the user's `snapshotKeep` setting are pruned.
 *
 * Everything is best-effort: a failed or skipped snapshot only logs a warning
 * and never blocks the Space business path. The scheduler runs shortly after
 * Host activation, every six hours, and once more on unload when the day has
 * no snapshot yet.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { SpaceStoreHandle, SpaceStoreLogger } from './store.js';

/** Subdirectory of the Space data directory that holds snapshots. */
export const BACKUPS_DIR_NAME = 'backups';
/** Snapshot file name: `space-YYYYMMDD.db.gz`. */
const SNAPSHOT_NAME = /^space-\d{8}\.db\.gz$/;
const TEMP_NAME = /^\.snapshot-\d+-\d+\.db(?:\.gz)?$/;
const TEMP_TTL_MS = 60 * 60_000;
const FREE_SPACE_MARGIN = 32 * 1024 * 1024;
const FREE_SPACE_FACTOR = 2.2;
const GZIP_LEVEL = 6;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_STARTUP_DELAY_MS = 10_000;

/** Absolute path of the snapshot directory for a data directory. */
export function backupsDirectory(dataDirectory: string): string {
  return join(dataDirectory, BACKUPS_DIR_NAME);
}

/** Local calendar day key used in snapshot file names. */
export function snapshotDay(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/** Snapshot file name for the given clock. */
export function snapshotFileName(now: Date): string {
  return `space-${snapshotDay(now)}.db.gz`;
}

export interface SnapshotFile {
  name: string;
  path: string;
  bytes: number;
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

async function availableBytes(directory: string): Promise<number | undefined> {
  try {
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/** Snapshots on disk, oldest first (file names sort by day). */
export async function listSnapshots(
  directory: string,
): Promise<SnapshotFile[]> {
  let names: string[];
  try {
    names = await readdir(backupsDirectory(directory));
  } catch {
    return [];
  }
  const files: SnapshotFile[] = [];
  for (const name of names) {
    if (!SNAPSHOT_NAME.test(name)) continue;
    const path = join(backupsDirectory(directory), name);
    const bytes = await fileSize(path);
    if (bytes === undefined) continue;
    files.push({ name, path, bytes });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** Total bytes currently held by snapshot files. */
export async function snapshotBytes(directory: string): Promise<number> {
  const files = await listSnapshots(directory);
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Delete the oldest snapshots so at most `keep` remain. */
export async function pruneSnapshots(
  directory: string,
  keep: number,
): Promise<void> {
  const files = await listSnapshots(directory);
  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const file of excess) await rm(file.path, { force: true });
}

/** Remove leftovers from an interrupted snapshot run. */
async function removeStaleTemps(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - TEMP_TTL_MS;
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    const path = join(directory, name);
    try {
      if ((await stat(path)).mtimeMs > cutoff) continue;
      await rm(path, { force: true });
    } catch {
      // A temp file that cannot be inspected/removed is harmless.
    }
  }
}

/** Injectables shared by the one-shot snapshot and the background scheduler. */
export interface SnapshotContext {
  store: SpaceStoreHandle;
  /** Space data directory (the parent of the `space.db` file). */
  directory: string;
  now: () => Date;
  logger: SpaceStoreLogger;
}

export interface SnapshotOutcome {
  status: 'created' | 'skipped' | 'failed';
  file?: string;
  reason?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the current day's snapshot when missing, then prune older ones.
 * Safe to call repeatedly; a day with an existing snapshot is a no-op.
 */
export async function createDailySnapshot(
  context: SnapshotContext,
): Promise<SnapshotOutcome> {
  const { store, directory, now, logger } = context;
  const backups = backupsDirectory(directory);
  const settings = store.getStorageSettings();
  const targetName = snapshotFileName(now());
  try {
    await mkdir(backups, { recursive: true, mode: 0o700 });
    await removeStaleTemps(backups);
    if ((await listSnapshots(directory)).some((file) => file.name === targetName)) {
      await pruneSnapshots(directory, settings.snapshotKeep);
      return { status: 'skipped', reason: 'today-already-snapshotted' };
    }
    const databaseBytes = (await fileSize(store.file)) ?? 0;
    const needed = Math.ceil(databaseBytes * FREE_SPACE_FACTOR) + FREE_SPACE_MARGIN;
    const available = await availableBytes(directory);
    if (available !== undefined && available < needed) {
      logger.warn?.(
        `[alter-dsh-space] 磁盘剩余空间不足，跳过今日备份（需要约 ${Math.ceil(needed / 1024 / 1024)} MiB）`,
      );
      return { status: 'skipped', reason: 'insufficient-space' };
    }
    const tempDatabase = join(
      backups,
      `.snapshot-${process.pid}-${Date.now()}.db`,
    );
    const tempArchive = `${tempDatabase}.gz`;
    try {
      await rm(tempDatabase, { force: true });
      await rm(tempArchive, { force: true });
      await store.snapshotInto(tempDatabase);
      await chmod(tempDatabase, 0o600).catch(() => undefined);
      await pipeline(
        createReadStream(tempDatabase),
        createGzip({ level: GZIP_LEVEL }),
        createWriteStream(tempArchive, { mode: 0o600 }),
      );
      await chmod(tempArchive, 0o600).catch(() => undefined);
      await rm(tempDatabase, { force: true });
      const target = join(backups, targetName);
      await rename(tempArchive, target);
      await pruneSnapshots(directory, settings.snapshotKeep);
      logger.info?.(`[alter-dsh-space] 已生成每日备份 ${basename(target)}`);
      return { status: 'created', file: target };
    } catch (error) {
      await rm(tempDatabase, { force: true }).catch(() => undefined);
      await rm(tempArchive, { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    logger.warn?.(`[alter-dsh-space] 每日备份失败：${messageOf(error)}`);
    return { status: 'failed', reason: messageOf(error) };
  }
}

export interface SnapshotSchedulerOptions extends SnapshotContext {
  /** Delay before the first background attempt. */
  startupDelayMs?: number;
  /** Period between background attempts. */
  intervalMs?: number;
}

export interface SnapshotScheduler {
  /** Arm the background timers (idempotent). */
  start(): void;
  /** Clear timers and run one final attempt for the current day. */
  dispose(): Promise<void>;
  /** Run one snapshot attempt now (shared with tests). */
  runNow(): Promise<SnapshotOutcome>;
}

/** Background daily-snapshot scheduler around {@link createDailySnapshot}. */
export function createSnapshotScheduler(
  options: SnapshotSchedulerOptions,
): SnapshotScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<SnapshotOutcome> | undefined;

  function runNow(): Promise<SnapshotOutcome> {
    if (active) return active;
    active = createDailySnapshot(options).finally(() => {
      active = undefined;
    });
    return active;
  }

  function clearTimers(): void {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
    if (intervalTimer !== undefined) clearInterval(intervalTimer);
    startupTimer = undefined;
    intervalTimer = undefined;
  }

  return {
    start() {
      if (startupTimer !== undefined || intervalTimer !== undefined) return;
      startupTimer = setTimeout(() => {
        startupTimer = undefined;
        void runNow();
      }, startupDelayMs);
      startupTimer.unref?.();
      intervalTimer = setInterval(() => {
        void runNow();
      }, intervalMs);
      intervalTimer.unref?.();
    },
    async dispose() {
      clearTimers();
      await active?.catch(() => undefined);
      await runNow().catch(() => undefined);
    },
    runNow,
  };
}
