/**
 * Server-side migration endpoints: receive a consistent Space data bundle,
 * verify it, replace this server's data while paused, and export the current
 * data for the reverse direction.
 *
 * All endpoints live under `/api/alter-space/migrate`; the HTTP carrier
 * authenticates them with the same bearer token as the RPC surface.
 *
 * Replacing a database is not crash-safe, so the previous database is kept in
 * `.migration/backup-<id>` until the seven-day sweep removes it. The host can
 * ask the server to restore that backup (`POST /rollback`) when the authority
 * switch on its side failed after a successful commit.
 *
 * @module @alter-dsh/space/migration/service
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalSpaceRuntime } from '../../host/core/runtime.js';
import {
  countUnpackedFiles,
  isBundlePartName,
  sha256File,
  unpackBundleTo,
  writeBundleFile,
  listAssetEntries,
} from '../../host/control/migration/bundle.js';
import {
  SPACE_DATA_COUNT_KEYS,
  isEmptySpaceDatabase,
  readDatabaseFacts,
  readSpaceDataCounts,
  snapshotSpaceDatabase,
  type SpaceDataCounts,
} from '../../host/control/migration/snapshot.js';
import { sweepMigrationStaging } from '../../host/control/migration/staging.js';
import { SPACE_DB_FORMAT_VERSION } from '../../host/persistence/store.js';
import { SPACE_PROTOCOL_VERSION } from '../../host/core/protocol.js';

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

/** Callbacks the migration handler needs from the server lifecycle. */
export interface MigrationRuntimeHost {
  readonly dataDir: string;
  readonly logger?: LoggerLike;
  current(): LocalSpaceRuntime;
  /** Close the authority so its database files can be replaced. */
  pause(): Promise<void>;
  /** Reopen the authority from the (possibly replaced) data directory. */
  resume(): Promise<LocalSpaceRuntime>;
  /**
   * Snapshot the freshly installed database even when today already has one.
   * The standalone server passes `config.snapshots`; defaults to `true`.
   */
  forceInitialSnapshot?: boolean;
}

/** One ready server migration handler. */
export interface ServerMigration {
  handle(request: Request, url: URL): Promise<Response | undefined>;
  /** Whether a commit is replacing the authority right now. */
  inflight(): boolean;
  /** Whether the authority is paused for a replace/rollback right now. */
  paused(): boolean;
  /**
   * Stop accepting new commits and wait for the in-flight one.
   * @param timeoutMs - bounded wait; a timeout only logs a warning.
   */
  drain(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** Base path claimed by migration routes. */
export const MIGRATION_PATH = '/api/alter-space/migrate';

const STAGING_DIR = '.migration';
/** Bound one upload request body; the client sends 8 MiB chunks. */
const MAX_PART_CHUNK_BYTES = 64 * 1024 * 1024;
/** Bound one commit payload: a bundle is split into a handful of parts. */
const MAX_COMMIT_PARTS = 16;
/** Bound the bytes one staged import may occupy on disk. */
const MAX_TOTAL_PART_BYTES = 64 * 1024 * 1024 * 1024;
/** Bound concurrent export staging directories (each holds one full snapshot). */
const MAX_ACTIVE_EXPORTS = 3;
/** Per-download response bound; clients page with Range headers. */
const EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const DRAIN_TIMEOUT_MS = 30_000;
/** Members that make up one target authority; all live directly in dataDir. */
const TARGET_MEMBERS = [
  'space.db',
  'space.db-wal',
  'space.db-shm',
  'space.db-journal',
  'assets',
] as const;
/** Journal files of the replaced database are not part of the backup. */
const EPHEMERAL_DB_MEMBERS = ['space.db-wal', 'space.db-shm', 'space.db-journal'] as const;

/** Stable 400 codes for malformed migration requests. */
const INVALID_REQUEST_CODES = new Set([
  'invalid_json',
  'invalid_id',
  'invalid_part_name',
  'invalid_offset',
  'missing_parts',
  'invalid_parts',
  'too_many_parts',
  'duplicate_part',
  'invalid_expected',
]);

function badRequest(error: unknown): Response | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!INVALID_REQUEST_CODES.has(error.message)) return undefined;
  return json(400, { ok: false, error: error.message });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (isPlainObject(parsed)) return parsed;
  } catch {
    throw new Error('invalid_json');
  }
  throw new Error('invalid_json');
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    throw new Error('invalid_id');
  return value;
}

function safePartName(value: unknown): string {
  if (typeof value !== 'string' || !isBundlePartName(value))
    throw new Error('invalid_part_name');
  return value;
}

async function readOffset(value: string | null): Promise<number> {
  const offset = Number(value ?? '0');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid_offset');
  return offset;
}

/** Aggregate asset footprint under one data directory. */
async function assetFootprint(
  dataDir: string,
): Promise<{ assetCount: number; assetBytes: number }> {
  let assetCount = 0;
  let assetBytes = 0;
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        assetCount += 1;
        assetBytes += (await stat(absolute)).size;
      }
    }
  }
  await walk(join(dataDir, 'assets'));
  return { assetCount, assetBytes };
}

interface CommitPart {
  name: string;
  size: number;
  sha256: string;
}

interface CommitExpectation {
  counts?: Partial<Record<keyof SpaceDataCounts, number>>;
  fileCount?: number;
}

/**
 * Build the migration handler for one server instance.
 * @param host - data directory and runtime pause/resume hooks.
 */
export function createServerMigration(
  host: MigrationRuntimeHost,
): ServerMigration {
  const logger = host.logger ?? {};
  const dataDir = host.dataDir;
  const stagingRoot = join(dataDir, STAGING_DIR);
  let closed = false;
  let draining = false;
  let pausedState = false;
  let rollingBack = false;
  let activeCommit: Promise<Response> | undefined;
  void sweepMigrationStaging(dataDir).catch(() => undefined);

  async function targetStatus(): Promise<Record<string, unknown>> {
    const dbFile = join(dataDir, 'space.db');
    let facts;
    let counts = null;
    try {
      facts = readDatabaseFacts(dbFile);
      counts = readSpaceDataCounts(dbFile);
    } catch {
      facts = undefined;
      counts = null;
    }
    const assets = await assetFootprint(dataDir);
    const empty = counts === null ? false : isEmptySpaceDatabase(dbFile);
    return {
      protocolVersion: SPACE_PROTOCOL_VERSION,
      databaseSchemaVersion:
        facts?.userVersion ?? SPACE_DB_FORMAT_VERSION,
      supportedDatabaseSchemaVersion: SPACE_DB_FORMAT_VERSION,
      quickCheck: facts?.quickCheck ?? 'missing',
      empty,
      counts,
      ...assets,
    };
  }

  async function stagingFor(id: string): Promise<string> {
    const directory = join(stagingRoot, `import-${id}`);
    await mkdir(join(directory, 'parts'), { recursive: true, mode: 0o700 });
    return directory;
  }

  async function hasImportMeta(id: string): Promise<boolean> {
    try {
      return (await stat(join(stagingRoot, `import-${id}`, 'meta.json'))).isFile();
    } catch {
      return false;
    }
  }

  async function handleStatus(): Promise<Response> {
    return json(200, { ok: true, ...(await targetStatus()) });
  }

  async function handlePrepare(request: Request): Promise<Response> {
    const body = await readJson(request);
    const overwrite = body.overwrite === true;
    const status = await targetStatus();
    if (status.empty !== true && !overwrite) {
      return json(409, {
        ok: false,
        error: 'target_not_empty',
        message: '目标服务器已有空间数据；确认覆盖后重试',
        ...status,
      });
    }
    const id = randomUUID().replaceAll('-', '');
    const directory = await stagingFor(id);
    await writeFile(
      join(directory, 'meta.json'),
      JSON.stringify({ id, createdAt: new Date().toISOString(), overwrite }),
      { mode: 0o600 },
    );
    return json(200, { ok: true, id });
  }

  async function handlePart(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const id = requireId(url.searchParams.get('id'));
    const name = safePartName(url.searchParams.get('name'));
    if (!(await hasImportMeta(id)))
      return json(404, { ok: false, error: 'unknown_migration' });
    const offset = await readOffset(url.searchParams.get('offset'));
    const directory = await stagingFor(id);
    const file = join(directory, 'parts', name);
    let current = 0;
    try {
      current = (await stat(file)).size;
    } catch {
      current = 0;
    }
    if (offset !== current)
      return json(409, { ok: false, error: 'offset_mismatch', offset: current });
    const body = Buffer.from(await request.arrayBuffer());
    if (body.byteLength > MAX_PART_CHUNK_BYTES)
      return json(413, { ok: false, error: 'part_too_large' });
    const handle = await open(file, current === 0 ? 'w' : 'r+');
    try {
      await handle.write(body, 0, body.byteLength, current);
    } finally {
      await handle.close();
    }
    return json(200, { ok: true, size: current + body.byteLength });
  }

  function readCommitParts(value: unknown): CommitPart[] {
    if (!Array.isArray(value) || value.length === 0)
      throw new Error('missing_parts');
    if (value.length > MAX_COMMIT_PARTS) throw new Error('too_many_parts');
    const parts: CommitPart[] = [];
    const names = new Set<string>();
    for (const item of value) {
      if (typeof item !== 'object' || item === null) throw new Error('invalid_parts');
      const record = item as Record<string, unknown>;
      const name = safePartName(record.name);
      if (names.has(name)) throw new Error('duplicate_part');
      names.add(name);
      if (typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size < 0)
        throw new Error('invalid_parts');
      if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256))
        throw new Error('invalid_parts');
      parts.push({ name, size: record.size, sha256: record.sha256 });
    }
    return parts;
  }

  /**
   * Parse the sender's expected facts. Optional for backward compatibility:
   * when present every field must match the unpacked bundle exactly, which is
   * what turns a silent partial upload into a 400 before the target changes.
   */
  function readCommitExpectation(value: unknown): CommitExpectation | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isPlainObject(value)) throw new Error('invalid_expected');
    const expectation: CommitExpectation = {};
    const rawCounts = value.counts;
    if (rawCounts !== undefined) {
      if (!isPlainObject(rawCounts)) throw new Error('invalid_expected');
      const counts: Partial<Record<keyof SpaceDataCounts, number>> = {};
      for (const [key, count] of Object.entries(rawCounts)) {
        if (!(SPACE_DATA_COUNT_KEYS as readonly string[]).includes(key))
          throw new Error('invalid_expected');
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
          throw new Error('invalid_expected');
        counts[key as keyof SpaceDataCounts] = count;
      }
      expectation.counts = counts;
    }
    const fileCount = value.fileCount;
    if (fileCount !== undefined) {
      if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0)
        throw new Error('invalid_expected');
      expectation.fileCount = fileCount;
    }
    return expectation;
  }

  /**
   * Move every target member into the backup directory.
   *
   * The returned names are exactly the members that moved; a non-ENOENT
   * failure aborts the move so the caller can restore what already moved
   * instead of silently committing over data it could not back up.
   */
  async function moveTargetAside(backup: string): Promise<string[]> {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const moved: string[] = [];
    for (const name of TARGET_MEMBERS) {
      const from = join(dataDir, name);
      const to = join(backup, name);
      try {
        await rename(from, to);
        moved.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return moved;
  }

  /**
   * Restore the members actually present in `backup`.
   *
   * Only backed-up members are replaced: a member the move never captured is
   * left untouched, so a partially captured backup can never delete live data.
   * Journal files of the replaced database are removed when the backup does
   * not carry them; they are not user data and would shadow the restored file.
   */
  async function restoreBackup(backup: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(backup);
    } catch {
      return;
    }
    for (const name of names) {
      const from = join(backup, name);
      const to = join(dataDir, name);
      // Remove the half-installed member first: renaming a directory over a
      // non-empty one fails with ENOTEMPTY and would leave a mixed target.
      await rm(to, { recursive: true, force: true });
      await rename(from, to);
    }
    for (const name of EPHEMERAL_DB_MEMBERS) {
      if (names.includes(name)) continue;
      await rm(join(dataDir, name), { force: true }).catch(() => undefined);
    }
  }

  /** Count unfinished export staging directories (each holds a snapshot). */
  async function activeExportCount(): Promise<number> {
    try {
      const names = await readdir(stagingRoot);
      return names.filter((name) => name.startsWith('export-')).length;
    } catch {
      return 0;
    }
  }

  function handleCommit(request: Request): Promise<Response> {
    if (closed || draining) return Promise.resolve(json(503, { ok: false, error: 'server_closing' }));
    if (activeCommit !== undefined)
      return Promise.resolve(
        json(409, {
          ok: false,
          error: 'commit_in_progress',
          message: '另一个迁移正在替换本服务端的数据，请稍后重试',
        }),
      );
    const run = commit(request).catch(
      (error: unknown) =>
        badRequest(error) ??
        json(500, {
          ok: false,
          error: 'commit_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    activeCommit = run;
    return run.finally(() => {
      if (activeCommit === run) activeCommit = undefined;
    });
  }

  async function commit(request: Request): Promise<Response> {
    const body = await readJson(request);
    const id = requireId(body.id);
    const parts = readCommitParts(body.parts);
    const expectation = readCommitExpectation(body.expected);
    const overwrite = body.overwrite === true;
    const totalBytes = parts.reduce((sum, part) => sum + part.size, 0);
    if (totalBytes > MAX_TOTAL_PART_BYTES)
      return json(413, {
        ok: false,
        error: 'staging_too_large',
        message: '迁移暂存超过服务端上限（64 GiB）',
        bytes: totalBytes,
      });
    const directory = join(stagingRoot, `import-${id}`);
    let meta: { overwrite?: boolean } = {};
    try {
      meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) as {
        overwrite?: boolean;
      };
    } catch {
      return json(404, { ok: false, error: 'unknown_migration' });
    }
    const status = await targetStatus();
    if (status.empty !== true && !overwrite && meta.overwrite !== true)
      return json(409, {
        ok: false,
        error: 'target_not_empty',
        message: '目标服务器已有数据；需要显式覆盖确认',
      });
    // Verify uploaded parts before touching the target.
    for (const part of parts) {
      const file = join(directory, 'parts', part.name);
      let info;
      try {
        info = await stat(file);
      } catch {
        return json(400, { ok: false, error: 'missing_part', part: part.name });
      }
      if (info.size !== part.size)
        return json(400, { ok: false, error: 'part_size_mismatch', part: part.name });
      if ((await sha256File(file)) !== part.sha256)
        return json(400, { ok: false, error: 'part_hash_mismatch', part: part.name });
    }
    const unpacked = join(directory, 'data');
    await rm(unpacked, { recursive: true, force: true });
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    try {
      for (const part of parts) {
        await unpackBundleTo(join(directory, 'parts', part.name), unpacked);
      }
    } catch (error) {
      return json(400, {
        ok: false,
        error: 'bundle_invalid',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // Everything below verifies the staged bundle while the live authority is
    // still serving; a mismatch returns 400 with the target untouched.
    const stagedDb = join(unpacked, 'space.db');
    let facts;
    try {
      facts = readDatabaseFacts(stagedDb);
    } catch {
      return json(400, { ok: false, error: 'database_unreadable' });
    }
    if (facts.quickCheck !== 'ok')
      return json(400, {
        ok: false,
        error: 'database_corrupt',
        quickCheck: facts.quickCheck,
      });
    if (facts.userVersion > SPACE_DB_FORMAT_VERSION)
      return json(400, {
        ok: false,
        error: 'schema_too_new',
        schemaVersion: facts.userVersion,
        supported: SPACE_DB_FORMAT_VERSION,
      });
    const stagedCounts = readSpaceDataCounts(stagedDb);
    if (expectation?.counts !== undefined) {
      const mismatched = (
        Object.keys(expectation.counts) as Array<keyof SpaceDataCounts>
      ).filter((key) => stagedCounts[key] !== expectation.counts?.[key]);
      if (mismatched.length > 0)
        return json(400, {
          ok: false,
          error: 'commit_counts_mismatch',
          fields: mismatched,
          expected: expectation.counts,
          actual: stagedCounts,
        });
    }
    const unpackedFiles = await countUnpackedFiles(unpacked);
    if (
      expectation?.fileCount !== undefined &&
      unpackedFiles !== expectation.fileCount
    )
      return json(400, {
        ok: false,
        error: 'commit_files_mismatch',
        expected: expectation.fileCount,
        actual: unpackedFiles,
      });
    const backup = join(stagingRoot, `backup-${id}`);
    pausedState = true;
    try {
      await host.pause();
    } catch (error) {
      pausedState = false;
      // A partially closed runtime must be reopened before reporting failure,
      // otherwise every later business request hits a closed database.
      await host.resume().catch(() => undefined);
      throw new Error(
        `暂停服务端运行时失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await moveTargetAside(backup);
      await rename(stagedDb, join(dataDir, 'space.db'));
      const stagedAssets = join(unpacked, 'assets');
      try {
        await rename(stagedAssets, join(dataDir, 'assets'));
      } catch (error) {
        // Only a missing directory (empty export) is acceptable; any other
        // failure must roll the whole commit back.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const resumed = await host.resume();
      if (host.forceInitialSnapshot !== false) {
        await resumed.snapshotNow().catch((error: unknown) => {
          logger.warn?.(
            `[space-server] 迁移后初始快照失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    } catch (error) {
      await restoreBackup(backup).catch(() => undefined);
      await host.resume().catch(() => undefined);
      return json(500, {
        ok: false,
        error: 'commit_failed',
        message: error instanceof Error ? error.message : String(error),
        backup,
      });
    } finally {
      pausedState = false;
    }
    const counts = readSpaceDataCounts(join(dataDir, 'space.db'));
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    logger.info?.(
      `[space-server] 迁移完成：${String(counts.spaces)} 个空间，${String(
        counts.nodes,
      )} 个节点`,
    );
    return json(200, {
      ok: true,
      counts,
      backup,
      fileCount: unpackedFiles,
      schemaVersion: facts.userVersion,
    });
  }

  async function handleRollback(request: Request): Promise<Response> {
    if (closed || draining)
      return json(503, { ok: false, error: 'server_closing' });
    if (activeCommit !== undefined || rollingBack)
      return json(409, {
        ok: false,
        error: 'commit_in_progress',
        message: '服务端正在替换数据，请稍后重试',
      });
    const body = await readJson(request);
    const id = requireId(body.id);
    const backup = join(stagingRoot, `backup-${id}`);
    let names: string[];
    try {
      names = await readdir(backup);
    } catch {
      return json(404, { ok: false, error: 'unknown_backup' });
    }
    if (names.length === 0)
      return json(404, { ok: false, error: 'unknown_backup' });
    rollingBack = true;
    pausedState = true;
    try {
      try {
        await host.pause();
      } catch (error) {
        pausedState = false;
        await host.resume().catch(() => undefined);
        throw new Error(
          `暂停服务端运行时失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        await restoreBackup(backup);
        const resumed = await host.resume();
        // Today's snapshot may already describe the rejected database; refresh
        // it so the recovery baseline keeps matching the restored authority.
        if (host.forceInitialSnapshot !== false) {
          await resumed.snapshotNow().catch((error: unknown) => {
            logger.warn?.(
              `[space-server] 回滚后快照失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      } catch (error) {
        await host.resume().catch(() => undefined);
        return json(500, {
          ok: false,
          error: 'rollback_failed',
          message: error instanceof Error ? error.message : String(error),
          backup,
        });
      }
      pausedState = false;
      const counts = readSpaceDataCounts(join(dataDir, 'space.db'));
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      logger.info?.(
        `[space-server] 迁移回滚完成：${String(counts.spaces)} 个空间，${String(
          counts.nodes,
        )} 个节点`,
      );
      return json(200, { ok: true, restored: true, counts });
    } catch (error) {
      pausedState = false;
      return json(500, {
        ok: false,
        error: 'rollback_failed',
        message: error instanceof Error ? error.message : String(error),
        backup,
      });
    } finally {
      rollingBack = false;
    }
  }

  async function handleExport(): Promise<Response> {
    if (closed || draining)
      return json(503, { ok: false, error: 'server_closing' });
    if ((await activeExportCount()) >= MAX_ACTIVE_EXPORTS)
      return json(429, {
        ok: false,
        error: 'migration_busy',
        message: '服务端有过多未完成的导出任务，请稍后重试',
      });
    const id = randomUUID().replaceAll('-', '');
    const directory = join(stagingRoot, `export-${id}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshot = join(directory, 'space.db');
    try {
      snapshotSpaceDatabase(join(dataDir, 'space.db'), snapshot);
      const entries = [
        { path: 'space.db', source: snapshot },
        ...(await listAssetEntries(dataDir)),
      ];
      const bundle = join(directory, 'export.bundle');
      const written = await writeBundleFile(bundle, entries);
      return json(200, {
        ok: true,
        id,
        name: 'export.bundle',
        size: written.size,
        sha256: written.sha256,
        fileCount: written.fileCount,
        payloadBytes: written.payloadBytes,
        counts: readSpaceDataCounts(snapshot),
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      return json(500, {
        ok: false,
        error: 'export_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleExportPart(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const id = requireId(url.searchParams.get('id'));
    const rangeMatch = /^bytes=(\d+)-/.exec(request.headers.get('range') ?? '');
    const offset = await readOffset(
      rangeMatch?.[1] ?? url.searchParams.get('offset'),
    );
    const file = join(stagingRoot, `export-${id}`, 'export.bundle');
    let info;
    try {
      info = await stat(file);
    } catch {
      return json(404, { ok: false, error: 'unknown_export' });
    }
    if (offset >= info.size)
      return json(416, { ok: false, error: 'offset_out_of_range' });
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      request.headers.get('range') ?? '',
    );
    const requestedEnd =
      range === null || range[2] === ''
        ? offset + EXPORT_CHUNK_BYTES - 1
        : Math.min(Number(range[2]), offset + EXPORT_CHUNK_BYTES - 1);
    const end = Math.min(info.size - 1, Math.max(offset, requestedEnd));
    const length = end - offset + 1;
    const handle = await open(file, 'r');
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }
    return new Response(buffer, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(length),
        'x-total-size': String(info.size),
        'x-offset-start': String(offset),
      },
    });
  }

  async function handleExportDelete(url: URL): Promise<Response> {
    const id = requireId(url.searchParams.get('id'));
    // One id is used for both directions: drop the export bundle and the
    // import staging directory so a failed/cancelled transfer leaves no copy
    // of the snapshot on disk.
    for (const name of [`export-${id}`, `import-${id}`]) {
      await rm(join(stagingRoot, name), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    return json(200, { ok: true });
  }

  async function waitForActiveCommit(timeoutMs: number): Promise<void> {
    const active = activeCommit;
    if (active === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([
      active.then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'timeout')
      logger.warn?.(
        `[space-server] 关闭前等待迁移提交超时（${String(timeoutMs)}ms），继续关闭`,
      );
  }

  return {
    async handle(request, url): Promise<Response | undefined> {
      if (closed) return json(503, { ok: false, error: 'server_closing' });
      try {
        if (url.pathname === `${MIGRATION_PATH}/status` && request.method === 'GET')
          return await handleStatus();
        if (url.pathname === `${MIGRATION_PATH}/prepare` && request.method === 'POST')
          return await handlePrepare(request);
        if (url.pathname === `${MIGRATION_PATH}/part` && request.method === 'PUT')
          return await handlePart(request, url);
        if (url.pathname === `${MIGRATION_PATH}/commit` && request.method === 'POST')
          return await handleCommit(request);
        if (url.pathname === `${MIGRATION_PATH}/rollback` && request.method === 'POST')
          return await handleRollback(request);
        if (url.pathname === `${MIGRATION_PATH}/export` && request.method === 'POST')
          return await handleExport();
        if (
          url.pathname === `${MIGRATION_PATH}/export/part` &&
          request.method === 'GET'
        )
          return await handleExportPart(request, url);
        if (url.pathname === `${MIGRATION_PATH}/export` && request.method === 'DELETE')
          return await handleExportDelete(url);
        return json(404, { ok: false, error: 'not_found' });
      } catch (error) {
        const invalid = badRequest(error);
        if (invalid !== undefined) return invalid;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn?.(`[space-server] 迁移请求失败：${message}`);
        return json(500, { ok: false, error: 'migration_failed', message });
      }
    },
    inflight(): boolean {
      return activeCommit !== undefined;
    },
    paused(): boolean {
      return pausedState;
    },
    async drain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
      draining = true;
      await waitForActiveCommit(timeoutMs);
    },
    async close() {
      closed = true;
      draining = true;
      await waitForActiveCommit(DRAIN_TIMEOUT_MS);
    },
  };
}
