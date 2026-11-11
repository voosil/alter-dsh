/**
 * Server-side migration endpoints: receive a consistent Space data bundle,
 * verify it, replace this server's data while paused, and export the current
 * data for the reverse direction.
 *
 * All endpoints live under `/api/alter-space/migrate`; the HTTP carrier
 * authenticates them with the same bearer token as the RPC surface.
 *
 * @module @alter-dsh/space/server/migration
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
import type { LocalSpaceRuntime } from '../host/runtime.js';
import {
  isBundlePartName,
  sha256File,
  unpackBundleTo,
  writeBundleFile,
  listAssetEntries,
} from '../host/migration/bundle.js';
import {
  isEmptySpaceDatabase,
  readDatabaseFacts,
  readSpaceDataCounts,
  snapshotSpaceDatabase,
} from '../host/migration/snapshot.js';
import { SPACE_DB_FORMAT_VERSION } from '../host/store.js';
import { SPACE_PROTOCOL_VERSION } from '../host/protocol.js';

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
}

/** One ready server migration handler. */
export interface ServerMigration {
  handle(request: Request, url: URL): Promise<Response | undefined>;
  close(): Promise<void>;
}

/** Base path claimed by migration routes. */
export const MIGRATION_PATH = '/api/alter-space/migrate';

const STAGING_DIR = '.migration';
const MAX_PART_BYTES = 64 * 1024 * 1024;
/** Per-download response bound; clients page with Range headers. */
const EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9-]{8,64}$/;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
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

/** Remove abandoned import/export/backup staging older than one week. */
async function sweepStaleStaging(stagingRoot: string): Promise<void> {
  const { stat } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(stagingRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of names) {
    const absolute = join(stagingRoot, name);
    try {
      const info = await stat(absolute);
      if (info.mtimeMs < cutoff)
        await rm(absolute, { recursive: true, force: true });
    } catch {
      // A concurrent transfer may own the directory; leave it alone.
    }
  }
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
  let committing = false;
  void sweepStaleStaging(stagingRoot).catch(() => undefined);

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
    if (body.byteLength > MAX_PART_BYTES)
      return json(413, { ok: false, error: 'part_too_large' });
    const handle = await open(file, current === 0 ? 'w' : 'r+');
    try {
      await handle.write(body, 0, body.byteLength, current);
    } finally {
      await handle.close();
    }
    return json(200, { ok: true, size: current + body.byteLength });
  }

  interface CommitPart {
    name: string;
    size: number;
    sha256: string;
  }

  function readCommitParts(value: unknown): CommitPart[] {
    if (!Array.isArray(value) || value.length === 0)
      throw new Error('missing_parts');
    const parts: CommitPart[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) throw new Error('invalid_parts');
      const record = item as Record<string, unknown>;
      const name = safePartName(record.name);
      if (typeof record.size !== 'number' || record.size < 0)
        throw new Error('invalid_parts');
      if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256))
        throw new Error('invalid_parts');
      parts.push({ name, size: record.size, sha256: record.sha256 });
    }
    return parts;
  }

  async function restoreBackup(backup: string): Promise<void> {
    for (const name of ['space.db', 'space.db-wal', 'space.db-shm', 'assets']) {
      const from = join(backup, name);
      const to = join(dataDir, name);
      // Remove the half-installed member first: renaming a directory over a
      // non-empty one fails with ENOTEMPTY and would leave a mixed target.
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      try {
        await rename(from, to);
      } catch {
        // Missing members simply mean the target had no such file.
      }
    }
  }

  async function moveTargetAside(backup: string): Promise<void> {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of ['space.db', 'space.db-wal', 'space.db-shm', 'assets']) {
      try {
        await rename(join(dataDir, name), join(backup, name));
      } catch {
        // Absent files (fresh server, no assets) need no backup entry.
      }
    }
  }

  async function handleCommit(request: Request): Promise<Response> {
    if (committing)
      return json(409, {
        ok: false,
        error: 'commit_in_progress',
        message: '另一个迁移正在替换本服务端的数据，请稍后重试',
      });
    committing = true;
    try {
      return await commit(request);
    } finally {
      committing = false;
    }
  }

  async function commit(request: Request): Promise<Response> {
    const body = await readJson(request);
    const id = requireId(body.id);
    const parts = readCommitParts(body.parts);
    const overwrite = body.overwrite === true;
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
    const backup = join(stagingRoot, `backup-${id}`);
    try {
      await host.pause();
    } catch (error) {
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
      await host.resume();
    } catch (error) {
      await restoreBackup(backup);
      await host.resume().catch(() => undefined);
      return json(500, {
        ok: false,
        error: 'commit_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const counts = readSpaceDataCounts(join(dataDir, 'space.db'));
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    logger.info?.(
      `[space-server] 迁移完成：${String(counts.spaces)} 个空间，${String(
        counts.nodes,
      )} 个节点`,
    );
    return json(200, { ok: true, counts, backup });
  }

  async function handleExport(): Promise<Response> {
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
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'invalid_json' || message === 'invalid_id' || message === 'invalid_part_name' || message === 'invalid_offset' || message === 'missing_parts' || message === 'invalid_parts')
          return json(400, { ok: false, error: message });
        logger.warn?.(`[space-server] 迁移请求失败：${message}`);
        return json(500, { ok: false, error: 'migration_failed', message });
      }
    },
    async close() {
      closed = true;
    },
  };
}
