/**
 * Local ↔ server data transfer used by the migration RPC, CLI and Agent tool.
 *
 * Local → server uploads two resumable bundle parts: all current assets first
 * (while the local authority may still be usable), then a consistent database
 * snapshot plus assets added since the first pass. Server → local downloads
 * one exported bundle in ranged chunks, verifies it and swaps the local data
 * directory after backing up the previous files.
 *
 * @module @alter-dsh/space/control/migration/transfer
 */
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { SPACE_PROTOCOL_VERSION } from '../../core/protocol.js';
import { SPACE_DB_FORMAT_VERSION } from '../../persistence/store.js';
import {
  countUnpackedFiles,
  isBundlePartName,
  listAssetEntries,
  sha256File,
  unpackBundleTo,
  writeBundleFile,
} from './bundle.js';
import {
  isEmptySpaceDatabase,
  readDatabaseFacts,
  readSpaceDataCounts,
  snapshotSpaceDatabase,
  type SpaceDataCounts,
} from './snapshot.js';

const MIGRATION_PATH = '/api/alter-space/migrate';
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Bounded retries for one chunk when the network drops or the server is busy. */
const CHUNK_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;
/** Members that make up the local authority; replaced as one unit. */
const LOCAL_MEMBERS = [
  'space.db',
  'space.db-wal',
  'space.db-shm',
  'space.db-journal',
  'assets',
] as const;
/** Journal files of the replaced database are not part of the backup. */
const EPHEMERAL_DB_MEMBERS = ['space.db-wal', 'space.db-shm', 'space.db-journal'] as const;

/** Direction accepted by {@link SpaceMigrationTransfer.preflight}. */
export type TransferDirection = 'to-server' | 'from-server';

/** Transfer phases reported to the UI and Agent tool. */
export type MigrationPhase =
  | 'preflight'
  | 'pack-assets'
  | 'upload-assets'
  | 'freeze'
  | 'snapshot'
  | 'upload-database'
  | 'commit'
  | 'download'
  | 'unpack'
  | 'verify'
  | 'switch'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Progress snapshot for one running transfer. */
export interface MigrationProgress {
  phase: MigrationPhase;
  message: string;
  transferredBytes: number;
  totalBytes: number | null;
}

/** Facts shared by preflight and tests. */
export interface MigrationPreflight {
  /** Whether the target server can receive this local database. */
  server: {
    reachable: boolean;
    message?: string;
    empty?: boolean;
    protocolVersion?: number;
    databaseSchemaVersion?: number;
    counts?: SpaceDataCounts | null;
  };
  local: {
    databaseBytes: number;
    assetBytes: number;
    assetCount: number;
    hasUserData: boolean;
  };
  /** `to-server` needs overwrite when the server has data. */
  needsOverwrite: boolean;
  /**
   * `to-server` would replace server rows that the local database does not
   * contain. Overwriting is then not just "this target is not empty" but a
   * real data loss on the other side, so the confirmation must say so.
   */
  overwriteDropsServerData: boolean;
  /** `from-server` replaces the local database; always needs confirmation. */
  replacesLocal: boolean;
  ok: boolean;
  message?: string;
}

/** Options shared by both directions. */
export interface TransferOptions {
  /** Replace an existing target database after an explicit confirmation. */
  overwrite?: boolean;
  /** Keep only the newest version snapshot per document. */
  trimHistory?: boolean;
  onProgress?: (progress: MigrationProgress) => void;
  signal?: AbortSignal;
}

/** Result of a successful local → server upload. */
export interface ToServerTransferResult {
  counts: SpaceDataCounts;
  /** Server-side backup of the replaced data, when the target had any. */
  serverBackup: string | null;
  /**
   * Ask the server to restore the database it replaced.
   *
   * Callers invoke this when the post-commit authority switch fails: the
   * server already committed the new data, so rolling back is the only way to
   * keep both sides on the same authority.
   */
  rollback(): Promise<void>;
}

/** Result of a successful server → local download. */
export interface FromServerTransferResult {
  counts: SpaceDataCounts;
  /**
   * Directory that holds the local database/assets replaced by this transfer
   * (inside `<dataDir>/.migration`), usable for manual recovery.
   */
  localBackup: string | null;
}

/** Freeze hooks shared by both directions. */
export interface TransferFreezeHooks {
  /** Called before the snapshot/export; must block writes and drain. */
  freeze?: () => Promise<void>;
  /**
   * Called when the transfer fails. `toServer` also calls it when the upload
   * finishes; `fromServer` keeps the freeze in place on success because the
   * caller owns the authority switch and must release the lock itself.
   */
  unfreeze?: () => Promise<void>;
}

/** One transfer bound to a local directory and a server identity. */
export interface SpaceMigrationTransfer {
  /**
   * Inspect the server and local data without changing either side.
   * @param direction - `from-server` tolerates a missing local database
   * (the point is to install one); `to-server` needs local data to send.
   */
  preflight(direction?: TransferDirection): Promise<MigrationPreflight>;
  /** Upload the local data and replace the server's data. */
  toServer(
    options?: TransferOptions & TransferFreezeHooks,
  ): Promise<ToServerTransferResult>;
  /** Download the server data and replace the local data directory. */
  fromServer(
    options?: TransferOptions & TransferFreezeHooks,
  ): Promise<FromServerTransferResult>;
}

/** Options for {@link createSpaceMigrationTransfer}. */
export interface MigrationTransferOptions {
  /** Local Space data directory. */
  directory: string;
  serverUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('migration_cancelled');
}

/**
 * Whether pushing the local database onto the server would drop rows the local
 * side does not have.
 *
 * `to-server` copies the local database over the server, so rows the server
 * holds and the local copy lacks are lost to the overwrite (they survive only in
 * the server-side backup). Rows the local side also has are not a loss: the
 * overwrite is a copy of content the user already owns. The counts are a coarse
 * comparison on purpose — they cannot prove equivalence, only sort "overwrite a
 * copy" from "delete data I never saw".
 */
function serverHasMoreRows(
  server: SpaceDataCounts | null,
  local: SpaceDataCounts | null,
): boolean {
  if (server === null || local === null) return false;
  const keys = Object.keys(local) as (keyof SpaceDataCounts)[];
  return keys.some((key) => Number(server[key] ?? 0) > Number(local?.[key] ?? 0));
}

/** An error that carries whether retrying the same chunk may help. */
interface ChunkError extends Error {
  retryable?: boolean;
}

function httpChunkError(message: string, status: number): ChunkError {
  const error: ChunkError = new Error(message);
  // 4xx means the request itself is wrong; only throttling and server-side
  // failures are worth another attempt.
  error.retryable = status === 429 || status >= 500;
  return error;
}

/** Sleep between retries, abortable so SIGINT wins over the backoff. */
function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined)
    return new Promise((resolveDelay) => {
      setTimeout(resolveDelay, ms);
    });
  if (signal.aborted) return Promise.reject(new Error('migration_cancelled'));
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(new Error('migration_cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry one resumable chunk with bounded exponential backoff.
 *
 * The chunk offset is part of the closure: a retry re-sends the same range, so
 * uploads resume at the server's acknowledged offset and downloads re-request
 * the same byte range. Aborting the signal must not be converted into a retry.
 */
async function withChunkRetries<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
    assertNotAborted(signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (signal?.aborted === true) throw error;
      const retryable = (error as ChunkError | undefined)?.retryable !== false;
      if (!retryable || attempt === CHUNK_ATTEMPTS) break;
      const delay = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
      await retryDelay(delay, signal);
    }
  }
  throw lastError;
}

async function pathSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Move every local authority member into `backup`, recording what moved.
 *
 * A non-ENOENT failure aborts the move so the caller can restore the members
 * that already moved instead of replacing a database it could not back up.
 */
async function moveMembersAside(
  directory: string,
  backup: string,
): Promise<string[]> {
  await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const name of LOCAL_MEMBERS) {
    const from = join(directory, name);
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
 * Members the move never captured are left untouched, so an incomplete backup
 * can never delete live data; journal files of the rejected database are
 * removed when the backup does not carry them.
 */
async function restoreMembers(backup: string, directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(backup);
  } catch {
    return;
  }
  for (const name of names) {
    await rm(join(directory, name), { recursive: true, force: true });
    await rename(join(backup, name), join(directory, name));
  }
  for (const name of EPHEMERAL_DB_MEMBERS) {
    if (names.includes(name)) continue;
    await rm(join(directory, name), { force: true }).catch(() => undefined);
  }
}

async function assetsFootprint(
  directory: string,
): Promise<{ assetCount: number; assetBytes: number }> {
  const entries = await listAssetEntries(directory);
  let bytes = 0;
  for (const entry of entries) bytes += await pathSize(entry.source);
  return { assetCount: entries.length, assetBytes: bytes };
}

interface ServerStatus {
  ok?: boolean;
  reachable?: boolean;
  empty?: boolean;
  protocolVersion?: number;
  databaseSchemaVersion?: number;
  supportedDatabaseSchemaVersion?: number;
  counts?: SpaceDataCounts | null;
  assetCount?: number;
  assetBytes?: number;
  message?: string;
}

interface JsonResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Build one migration transfer.
 * @param options - local directory and server identity.
 */
export function createSpaceMigrationTransfer(
  options: MigrationTransferOptions,
): SpaceMigrationTransfer {
  const baseUrl = options.serverUrl.replace(/\/+$/, '');
  const token = options.token;
  const directory = options.directory;
  const fetchImpl = options.fetchImpl ?? fetch;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${token}`, ...extra };
  }

  async function request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(5 * 60_000);
    return fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: headers((init.headers as Record<string, string>) ?? {}),
      signal:
        signal === undefined
          ? timeout
          : AbortSignal.any([signal, timeout]),
    });
  }

  async function jsonRequest<T extends JsonResponse>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await request(path, init, signal);
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      throw new Error(`服务端返回了无效响应（HTTP ${String(response.status)}）`);
    }
    if (!response.ok && body.error === undefined)
      throw new Error(`迁移请求失败（HTTP ${String(response.status)}）`);
    return body;
  }

  async function serverStatus(signal?: AbortSignal): Promise<ServerStatus> {
    const response = await request(
      `${MIGRATION_PATH}/status`,
      { method: 'GET' },
      signal,
    );
    const body = (await response.json()) as ServerStatus;
    if (!response.ok) throw new Error(body.message ?? '无法读取服务端迁移状态');
    return body;
  }

  async function uploadPart(
    id: string,
    name: string,
    file: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
    alreadyTransferred = 0,
  ): Promise<{ name: string; size: number; sha256: string }> {
    const size = await pathSize(file);
    let offset = alreadyTransferred;
    const handle = await open(file, 'r');
    try {
      while (offset < size) {
        assertNotAborted(signal);
        const length = Math.min(UPLOAD_CHUNK_BYTES, size - offset);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        // One attempt = one chunk at this offset. Retries reuse the same
        // offset (resumable); a 409 tells us the server's acknowledged offset.
        const nextOffset = await withChunkRetries(async () => {
          const response = await request(
            `${MIGRATION_PATH}/part?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&offset=${String(offset)}`,
            { method: 'PUT', body: buffer },
            signal,
          );
          const body = (await response.json().catch(() => ({}))) as JsonResponse;
          if (response.status === 409 && typeof body.offset === 'number') {
            if (body.offset === offset)
              throw new Error('上传迁移数据时偏移量不一致，请重试');
            return body.offset;
          }
          if (!response.ok)
            throw httpChunkError(
              body.message ?? '上传迁移数据失败',
              response.status,
            );
          return offset + length;
        }, signal);
        offset = nextOffset;
        onProgress(offset);
      }
    } finally {
      await handle.close();
    }
    return { name, size, sha256: await sha256File(file) };
  }

  async function downloadBundle(
    id: string,
    name: string,
    destination: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let offset = 0;
    let total: number | null = null;
    const handle = await open(destination, 'w', 0o600);
    try {
      while (total === null || offset < total) {
        assertNotAborted(signal);
        // Each attempt re-requests the same byte range, so a flaky network
        // simply resumes where the previous attempt stopped.
        const chunk = await withChunkRetries(async () => {
          const response = await request(
            `${MIGRATION_PATH}/export/part?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&offset=${String(offset)}`,
            {
              method: 'GET',
              headers: {
                ...(total === null ? {} : { range: `bytes=${offset}-` }),
              },
            },
            signal,
          );
          if (response.status === 416) return null;
          if (!response.ok) {
            const body = (await response
              .json()
              .catch(() => ({}))) as JsonResponse;
            throw httpChunkError(
              body.message ?? '下载迁移数据失败',
              response.status,
            );
          }
          if (total === null) {
            const header = Number(response.headers.get('x-total-size'));
            total = Number.isFinite(header) && header > 0 ? header : null;
          }
          const chunk = Buffer.from(await response.arrayBuffer());
          return chunk.byteLength === 0 ? null : chunk;
        }, signal);
        if (chunk === null) break;
        await handle.write(chunk, 0, chunk.byteLength, offset);
        offset += chunk.byteLength;
        onProgress(offset);
      }
    } finally {
      await handle.close();
    }
    if (total !== null && offset !== total)
      throw new Error('转储文件不完整，请重试');
  }

  return {
    async preflight(
      direction: TransferDirection = 'to-server',
    ): Promise<MigrationPreflight> {
      const localDb = join(directory, 'space.db');
      const localDbBytes = await pathSize(localDb);
      const assets = await assetsFootprint(directory);
      let localCounts: SpaceDataCounts | null = null;
      try {
        localCounts = readSpaceDataCounts(localDb);
      } catch {
        localCounts = null;
      }
      const localHasData =
        localCounts !== null && isEmptySpaceDatabase(localDb) === false;
      let server: ServerStatus = { reachable: false };
      try {
        server = { reachable: true, ...(await serverStatus()) };
      } catch (error) {
        return {
          server: {
            reachable: false,
            message: error instanceof Error ? error.message : String(error),
          },
          local: {
            databaseBytes: localDbBytes,
            assetBytes: assets.assetBytes,
            assetCount: assets.assetCount,
            hasUserData: localHasData,
          },
          needsOverwrite: false,
          overwriteDropsServerData: false,
          replacesLocal: true,
          ok: false,
          message: '无法连接 Space 服务端',
        };
      }
      const needsOverwrite = server.empty !== true;
      const overwriteDropsServerData =
        needsOverwrite && serverHasMoreRows(server.counts ?? null, localCounts);
      const protocolOk = server.protocolVersion === SPACE_PROTOCOL_VERSION;
      return {
        server: {
          reachable: true,
          empty: server.empty,
          ...(server.protocolVersion === undefined
            ? {}
            : { protocolVersion: server.protocolVersion }),
          ...(server.databaseSchemaVersion === undefined
            ? {}
            : { databaseSchemaVersion: server.databaseSchemaVersion }),
          counts: server.counts ?? null,
        },
        local: {
          databaseBytes: localDbBytes,
          assetBytes: assets.assetBytes,
          assetCount: assets.assetCount,
          hasUserData: localHasData,
        },
        needsOverwrite,
        overwriteDropsServerData,
        replacesLocal: direction === 'from-server',
        // `from-server` installs a database into a fresh local directory, so
        // a missing local file is expected; `to-server` needs one to send.
        ok: protocolOk && (direction === 'from-server' || localDbBytes > 0),
        ...(protocolOk
          ? {}
          : { message: '服务端协议版本不兼容' }),
      };
    },

    async toServer(
      transfer: TransferOptions & TransferFreezeHooks = {},
    ): Promise<ToServerTransferResult> {
      const { onProgress = () => undefined, signal } = transfer;
      const workRoot = join(directory, '.migration');
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      const job = join(workRoot, `local-${String(Date.now())}`);
      await mkdir(job, { recursive: true, mode: 0o700 });
      let frozen = false;
      let serverId: string | undefined;
      const progress = (
        phase: MigrationPhase,
        message: string,
        transferredBytes: number,
        totalBytes: number | null,
      ) => onProgress({ phase, message, transferredBytes, totalBytes });
      try {
        // Verify compatibility before uploading anything.
        const status = await serverStatus(signal);
        if (status.empty !== true && transfer.overwrite !== true)
          throw new Error(
            '目标服务器已有空间数据；请确认覆盖后重试（会先备份服务端数据）',
          );
        // Phase A: assets first while the local authority may still be usable.
        progress('pack-assets', '整理资产…', 0, null);
        const firstAssets = await listAssetEntries(directory);
        const packedAssets = new Set(firstAssets.map((entry) => entry.path));
        const assetsBundle = join(job, 'assets.bundle');
        const assetsWritten = await writeBundleFile(assetsBundle, firstAssets, (bytes) =>
          progress('pack-assets', '整理资产…', bytes, null),
        );
        const prepare = await jsonRequest<JsonResponse>(
          `${MIGRATION_PATH}/prepare`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ overwrite: transfer.overwrite === true }),
          },
          signal,
        );
        if (prepare.ok !== true || typeof prepare.id !== 'string')
          throw new Error(prepare.message ?? '服务端拒绝迁移准备请求');
        serverId = prepare.id;
        const partName = 'part-assets.bundle';
        if (assetsWritten.size > 0) {
          progress('upload-assets', '上传资产…', 0, assetsWritten.size);
          await uploadPart(
            serverId,
            partName,
            assetsBundle,
            (bytes) => progress('upload-assets', '上传资产…', bytes, assetsWritten.size),
            signal,
          );
        }
        const parts: Array<{ name: string; size: number; sha256: string }> = [];
        if (assetsWritten.size > 0) {
          parts.push({
            name: partName,
            size: assetsWritten.size,
            sha256: assetsWritten.sha256,
          });
        }
        // Phase B: freeze writes, snapshot the database, upload new assets.
        if (transfer.freeze !== undefined) {
          progress('freeze', '暂停本地写入…', 0, null);
          await transfer.freeze();
          frozen = true;
        }
        assertNotAborted(signal);
        progress('snapshot', '生成一致性快照…', 0, null);
        const snapshot = join(job, 'space.db');
        snapshotSpaceDatabase(join(directory, 'space.db'), snapshot, {
          trimHistory: transfer.trimHistory === true,
        });
        const allAssets = await listAssetEntries(directory);
        const delta = allAssets.filter((entry) => !packedAssets.has(entry.path));
        const finalBundle = join(job, 'final.bundle');
        const finalWritten = await writeBundleFile(
          finalBundle,
          [{ path: 'space.db', source: snapshot }, ...delta],
          (bytes) => progress('snapshot', '打包数据库…', bytes, null),
        );
        progress('upload-database', '上传数据库…', 0, finalWritten.size);
        const finalName = 'part-final.bundle';
        await uploadPart(
          serverId,
          finalName,
          finalBundle,
          (bytes) => progress('upload-database', '上传数据库…', bytes, finalWritten.size),
          signal,
        );
        parts.push({
          name: finalName,
          size: finalWritten.size,
          sha256: finalWritten.sha256,
        });
        const snapshotCounts = readSpaceDataCounts(snapshot);
        // What the server must see after unpacking both parts: the database
        // plus every distinct asset path either phase packed. The pre-commit
        // check turns a truncated/partial upload into a 400 before the target
        // is replaced.
        const expectedPaths = new Set<string>(['space.db']);
        for (const entry of firstAssets) expectedPaths.add(entry.path);
        for (const entry of allAssets) expectedPaths.add(entry.path);
        const migrationId = serverId;
        progress('commit', '服务端校验并替换数据…', finalWritten.size, finalWritten.size);
        const committed = await jsonRequest<JsonResponse>(
          `${MIGRATION_PATH}/commit`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: migrationId,
              overwrite: transfer.overwrite === true,
              parts,
              expected: {
                counts: snapshotCounts,
                fileCount: expectedPaths.size,
              },
            }),
          },
          signal,
        );
        if (committed.ok !== true) {
          const failedBackup =
            typeof committed.backup === 'string' ? committed.backup : null;
          throw new Error(
            `${committed.message ?? '服务端迁移提交失败'}${
              failedBackup === null
                ? ''
                : `；迁移前数据备份位于 ${failedBackup}（可调用服务端 ${MIGRATION_PATH}/rollback 恢复）`
            }`,
          );
        }
        const counts = (committed.counts ?? snapshotCounts) as SpaceDataCounts;
        const serverBackup =
          typeof committed.backup === 'string' ? committed.backup : null;
        /** Restore the server's pre-commit database (used by the caller's switch). */
        const rollback = async (): Promise<void> => {
          const response = await request(`${MIGRATION_PATH}/rollback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: migrationId }),
          });
          if (!response.ok) {
            const body = (await response
              .json()
              .catch(() => ({}))) as JsonResponse;
            throw new Error(
              body.message ??
                `服务端回滚失败（HTTP ${String(response.status)}）`,
            );
          }
        };
        // Defense in depth: the pre-commit handshake already verified the
        // staged bundle, but a server that resumed with different data means
        // the two authorities diverged. Roll the target back instead of
        // leaving a half-switched pair behind.
        const mismatch = (
          Object.keys(snapshotCounts) as Array<keyof SpaceDataCounts>
        ).filter(
          (key) => key !== 'assets' && counts[key] !== snapshotCounts[key],
        );
        if (mismatch.length > 0) {
          let recovery: string;
          try {
            await rollback();
            recovery = '已请求服务端回滚到迁移前数据';
          } catch (rollbackError) {
            recovery = `自动回滚失败（${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }）；请用服务端备份文件手动恢复`;
          }
          throw new Error(
            `服务端迁移后校验不一致（${mismatch.join('、')}）；${recovery}${
              serverBackup === null ? '' : `（备份：${serverBackup}）`
            }`,
          );
        }
        progress('commit', '迁移完成', finalWritten.size, finalWritten.size);
        return { counts, serverBackup, rollback };
      } catch (error) {
        if (serverId !== undefined) {
          await request(
            `${MIGRATION_PATH}/export?id=${encodeURIComponent(serverId)}`,
            { method: 'DELETE' },
          ).catch(() => undefined);
        }
        throw error;
      } finally {
        if (frozen && transfer.unfreeze !== undefined) {
          await transfer.unfreeze().catch(() => undefined);
        }
        await rm(job, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async fromServer(
      transfer: TransferOptions & TransferFreezeHooks = {},
    ): Promise<FromServerTransferResult> {
      const { onProgress = () => undefined, signal } = transfer;
      const workRoot = join(directory, '.migration');
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      const job = join(workRoot, `remote-${String(Date.now())}`);
      await mkdir(job, { recursive: true, mode: 0o700 });
      let frozen = false;
      let exportId: string | undefined;
      const progress = (
        phase: MigrationPhase,
        message: string,
        transferredBytes: number,
        totalBytes: number | null,
      ) => onProgress({ phase, message, transferredBytes, totalBytes });
      try {
        // Freeze before the server is asked for a snapshot: a write accepted
        // during the download would be acknowledged locally but missing from
        // the exported database. The lock is held until the caller's authority
        // switch; this method only releases it again on failure.
        if (transfer.freeze !== undefined) {
          progress('freeze', '暂停当前模式写入…', 0, null);
          await transfer.freeze();
          frozen = true;
        }
        assertNotAborted(signal);
        progress('download', '请求服务端导出快照…', 0, null);
        const exported = await jsonRequest<JsonResponse>(
          `${MIGRATION_PATH}/export`,
          { method: 'POST' },
          signal,
        );
        if (exported.ok !== true || typeof exported.id !== 'string')
          throw new Error(exported.message ?? '服务端导出失败');
        exportId = exported.id;
        const total =
          typeof exported.size === 'number' ? exported.size : null;
        const bundle = join(job, 'export.bundle');
        progress('download', '下载快照…', 0, total);
        await downloadBundle(
          exportId,
          typeof exported.name === 'string' ? exported.name : 'export.bundle',
          bundle,
          (bytes) => progress('download', '下载快照…', bytes, total),
          signal,
        );
        if (typeof exported.sha256 === 'string') {
          const actual = await sha256File(bundle);
          if (actual !== exported.sha256) throw new Error('下载校验失败，请重试');
        }
        assertNotAborted(signal);
        progress('unpack', '解包快照…', total ?? 0, total);
        const unpacked = join(job, 'data');
        await mkdir(unpacked, { recursive: true, mode: 0o700 });
        await unpackBundleTo(bundle, unpacked);
        const stagedDb = join(unpacked, 'space.db');
        progress('verify', '校验数据库…', total ?? 0, total);
        const facts = readDatabaseFacts(stagedDb);
        if (facts.quickCheck !== 'ok') throw new Error('服务端快照数据库损坏');
        if (facts.userVersion > SPACE_DB_FORMAT_VERSION)
          throw new Error(
            `服务端数据库结构版本 ${String(facts.userVersion)} 高于当前插件支持的 ${String(SPACE_DB_FORMAT_VERSION)}；请先升级插件`,
          );
        const incoming = readSpaceDataCounts(stagedDb);
        const expectedCounts = exported.counts;
        if (expectedCounts !== undefined && expectedCounts !== null) {
          const mismatched = Object.entries(
            expectedCounts as Record<string, unknown>,
          ).filter(([key, value]) => {
            const actual = (incoming as unknown as Record<string, unknown>)[key];
            return typeof value === 'number' && actual !== value;
          });
          if (mismatched.length > 0)
            throw new Error(
              `服务端快照校验不一致（${mismatched
                .map(([key]) => key)
                .join('、')}），已保留本地数据`,
            );
        }
        const unpackedFiles = await countUnpackedFiles(unpacked);
        if (
          typeof exported.fileCount === 'number' &&
          unpackedFiles !== exported.fileCount
        )
          throw new Error('服务端快照文件数量校验不一致，已保留本地数据');
        // Replace the local database and assets after backing up the old ones.
        // A failed move aborts here: restoring only the members the backup
        // actually captured can never delete local data it did not save.
        const backup = join(workRoot, `backup-${String(Date.now())}`);
        try {
          await moveMembersAside(directory, backup);
          await rename(stagedDb, join(directory, 'space.db'));
          const stagedAssets = join(unpacked, 'assets');
          try {
            await rename(stagedAssets, join(directory, 'assets'));
          } catch (error) {
            // No assets in this export is the only acceptable failure.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        } catch (error) {
          await restoreMembers(backup, directory).catch(() => undefined);
          throw error;
        }
        progress('verify', '写入完成', total ?? 0, total);
        return { counts: incoming, localBackup: backup };
      } catch (error) {
        if (frozen) {
          frozen = false;
          await transfer.unfreeze?.().catch(() => undefined);
        }
        throw error;
      } finally {
        if (exportId !== undefined) {
          await request(
            `${MIGRATION_PATH}/export?id=${encodeURIComponent(exportId)}`,
            { method: 'DELETE' },
          ).catch(() => undefined);
        }
        await rm(job, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Small helper for CLI/tests: verify one bundle file part name. */
export { isBundlePartName };
