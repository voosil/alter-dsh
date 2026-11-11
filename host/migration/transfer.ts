/**
 * Local ↔ server data transfer used by the migration RPC, CLI and Agent tool.
 *
 * Local → server uploads two resumable bundle parts: all current assets first
 * (while the local authority may still be usable), then a consistent database
 * snapshot plus assets added since the first pass. Server → local downloads
 * one exported bundle in ranged chunks, verifies it and swaps the local data
 * directory after backing up the previous files.
 *
 * @module @alter-dsh/space/migration/transfer
 */
import {
  mkdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { SPACE_PROTOCOL_VERSION } from '../protocol.js';
import { SPACE_DB_FORMAT_VERSION } from '../store.js';
import {
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

/** One transfer bound to a local directory and a server identity. */
export interface SpaceMigrationTransfer {
  /** Inspect the server and local data without changing either side. */
  preflight(): Promise<MigrationPreflight>;
  /** Upload the local data and replace the server's data. */
  toServer(
    options?: TransferOptions & {
      /** Called before the final snapshot (the caller blocks local writes). */
      freeze?: () => Promise<void>;
      /** Called after a successful commit/switch or on failure. */
      unfreeze?: () => Promise<void>;
    },
  ): Promise<{ counts: SpaceDataCounts; serverBackup: string | null }>;
  /** Download the server data and replace the local data directory. */
  fromServer(
    options?: TransferOptions & {
      freeze?: () => Promise<void>;
      unfreeze?: () => Promise<void>;
    },
  ): Promise<{ counts: SpaceDataCounts }>;
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

/** Count regular files in one unpacked bundle directory. */
async function countUnpackedFiles(directory: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let count = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) count += 1;
    }
  }
  await walk(directory);
  return count;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('migration_cancelled');
}

async function pathSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
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
        const response = await request(
          `${MIGRATION_PATH}/part?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}&offset=${String(offset)}`,
          { method: 'PUT', body: buffer },
          signal,
        );
        const body = (await response.json()) as JsonResponse;
        if (response.status === 409 && typeof body.offset === 'number') {
          offset = body.offset;
          onProgress(offset);
          continue;
        }
        if (!response.ok)
          throw new Error(body.message ?? '上传迁移数据失败');
        offset += length;
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
        if (response.status === 416) break;
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as JsonResponse;
          throw new Error(body.message ?? '下载迁移数据失败');
        }
        if (total === null) {
          const header = Number(response.headers.get('x-total-size'));
          total = Number.isFinite(header) && header > 0 ? header : null;
        }
        const chunk = Buffer.from(await response.arrayBuffer());
        if (chunk.byteLength === 0) break;
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
    async preflight(): Promise<MigrationPreflight> {
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
          replacesLocal: true,
          ok: false,
          message: '无法连接 Space 服务端',
        };
      }
      const needsOverwrite = server.empty !== true;
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
        replacesLocal: true,
        ok: protocolOk && localDbBytes > 0,
        ...(protocolOk
          ? {}
          : { message: '服务端协议版本不兼容' }),
      };
    },

    async toServer(transfer: TransferOptions & {
      freeze?: () => Promise<void>;
      unfreeze?: () => Promise<void>;
    } = {}) {
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
        progress('commit', '服务端校验并替换数据…', finalWritten.size, finalWritten.size);
        const committed = await jsonRequest<JsonResponse>(
          `${MIGRATION_PATH}/commit`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: serverId,
              overwrite: transfer.overwrite === true,
              parts,
            }),
          },
          signal,
        );
        if (committed.ok !== true)
          throw new Error(committed.message ?? '服务端迁移提交失败');
        const counts = (committed.counts ?? {
          spaces: 0,
          nodes: 0,
          thoughts: 0,
          comments: 0,
          versions: 0,
          assets: 0,
          events: 0,
        }) as SpaceDataCounts;
        // Asset rows are excluded here on purpose: the server runs startup GC
        // immediately after reopening the replaced database, so unreferenced
        // assets can legitimately disappear before the counts are read. Asset
        // integrity is covered by the bundle part hashes above.
        const mismatch = (
          Object.keys(snapshotCounts) as Array<keyof SpaceDataCounts>
        ).filter(
          (key) => key !== 'assets' && counts[key] !== snapshotCounts[key],
        );
        if (mismatch.length > 0)
          throw new Error(
            `服务端迁移校验不一致（${mismatch.join('、')}），当前权威保持不变`,
          );
        progress('commit', '迁移完成', finalWritten.size, finalWritten.size);
        return {
          counts,
          serverBackup:
            typeof committed.backup === 'string' ? committed.backup : null,
        };
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

    async fromServer(transfer: TransferOptions & {
      freeze?: () => Promise<void>;
      unfreeze?: () => Promise<void>;
    } = {}) {
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
        if (transfer.freeze !== undefined) {
          progress('freeze', '暂停当前模式写入…', 0, null);
          await transfer.freeze();
          frozen = true;
        }
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
        const backup = join(workRoot, `backup-${String(Date.now())}`);
        await mkdir(backup, { recursive: true, mode: 0o700 });
        for (const name of ['space.db', 'space.db-wal', 'space.db-shm', 'assets']) {
          try {
            await rename(join(directory, name), join(backup, name));
          } catch {
            // Missing members are fine on a fresh local directory.
          }
        }
        try {
          await rename(stagedDb, join(directory, 'space.db'));
          const stagedAssets = join(unpacked, 'assets');
          try {
            await rename(stagedAssets, join(directory, 'assets'));
          } catch {
            // No assets in this export.
          }
        } catch (error) {
          for (const name of ['space.db', 'space.db-wal', 'space.db-shm', 'assets']) {
            await rename(join(backup, name), join(directory, name)).catch(
              () => undefined,
            );
          }
          throw error;
        }
        progress('verify', '写入完成', total ?? 0, total);
        return { counts: incoming };
      } finally {
        if (exportId !== undefined) {
          await request(
            `${MIGRATION_PATH}/export?id=${encodeURIComponent(exportId)}`,
            { method: 'DELETE' },
          ).catch(() => undefined);
        }
        if (frozen && transfer.unfreeze !== undefined) {
          await transfer.unfreeze().catch(() => undefined);
        }
        await rm(job, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Small helper for CLI/tests: verify one bundle file part name. */
export { isBundlePartName };
