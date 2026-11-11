/**
 * Server-authority bridge: link status, read-through cache, optimistic
 * document writes and the durable outbox that replays them.
 *
 * The server stays the only authority. When the link drops, cached reads keep
 * the panel usable and document edits are applied to a local shadow, queued,
 * and replayed on reconnect with idempotency keys and revision checks.
 *
 * @module @alter-dsh/space/remote/bridge
 */
import { randomUUID } from 'node:crypto';
import type { BackendConnectionStatus } from '../backend.js';
import { isImageMime } from '../document/assets.js';
import {
  applyOperations,
} from '../document/ops.js';
import { parseMarkdownBlocks } from '../document/markdown.js';
import type {
  DocumentToolApi,
  DocumentToolAssetApi,
} from '../document/tools.js';
import {
  DocumentError,
  type AlterDoc,
  type Operation,
} from '../document/types.js';
import { isReadEndpoint } from '../endpoints.js';
import { SPACE_PROTOCOL_VERSION } from '../protocol.js';
import { SPACE_DB_FORMAT_VERSION } from '../store.js';
import {
  openRemoteCache,
  newOutboxIdempotencyKey,
  type RemoteCache,
} from './cache.js';
import type { RemoteClientOptions } from './client.js';
import { RemoteClientError, RemoteSpaceClient } from './client.js';

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

/** Options for one bridge bound to a local cache directory. */
export interface RemoteBridgeOptions {
  baseUrl: string;
  token: string;
  /** Local directory that owns the disposable cache database. */
  directory: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
  /** Extra gate used by a migration freeze to suspend queue replay. */
  pauseFlush?: () => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argsOf(payload: unknown): unknown[] {
  if (!isPlainObject(payload)) return [];
  return Array.isArray(payload.args) ? payload.args : [];
}

function valueOf(result: unknown): unknown {
  if (isPlainObject(result)) return result.value;
  return undefined;
}

function errorOf(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof RemoteClientError)
    return { error: { code: error.code, message: error.message } };
  if (error instanceof DocumentError)
    return { error: { code: error.code, message: error.message } };
  return {
    error: {
      code: 'remote/unavailable',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function isTransportError(error: unknown): boolean {
  // Only network-level failures are retryable transport errors. Business
  // errors returned inside a successful envelope (doc/conflict,
  // idempotency/conflict, ...) and protocol errors must reach their own
  // handling instead of parking the whole queue as "offline".
  return (
    error instanceof RemoteClientError && error.code === 'remote/unavailable'
  );
}

/** Whether an error is an authentication failure rather than a link failure. */
function isUnauthorizedError(error: unknown): boolean {
  return (
    error instanceof RemoteClientError && error.code === 'remote/unauthorized'
  );
}

function cacheKey(endpoint: string, args: unknown[]): string {
  return `${endpoint}\u0000${JSON.stringify(args)}`;
}

/** Read the args of one document write payload. */
function writeInput(payload: unknown): Record<string, unknown> | undefined {
  const args = argsOf(payload);
  return isPlainObject(args[0]) ? args[0] : undefined;
}

/**
 * One bridge instance; `close` releases the cache and the heartbeat.
 */
export interface RemoteBridge {
  readonly rpc: (
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly fetchAsset: (request: Request) => Promise<Response>;
  readonly document: DocumentToolApi;
  readonly assets: DocumentToolAssetApi;
  readonly status: BackendConnectionStatus;
  refresh(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Build the bridge for one server URL/token pair.
 * @param options - server, local cache directory and seams.
 */
export function createRemoteBridge(
  options: RemoteBridgeOptions,
): RemoteBridge {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? {};
  const clientOptions: RemoteClientOptions = {
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  };
  const client = new RemoteSpaceClient(clientOptions);
  const cache: RemoteCache = openRemoteCache(options.directory, options.baseUrl);
  let link: BackendConnectionStatus = { state: 'connecting' };
  let lastSyncedAt: string | undefined;
  let closed = false;
  let flushing: Promise<void> | undefined;
  let queuedRefresh = false;

  function counts(): { pending: number; conflicts: number; failed: number } {
    const value = cache.counts();
    return {
      pending: value.pending,
      conflicts: value.conflicts,
      failed: value.failed,
    };
  }

  function status(): BackendConnectionStatus {
    const queue = counts();
    return {
      ...link,
      pendingWrites: queue.pending,
      conflicts: queue.conflicts,
      failed: queue.failed,
      ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
    };
  }

  function markOnline(version?: string, protocolVersion?: number): void {
    link = {
      state: 'online',
      ...(version === undefined ? {} : { serverVersion: version }),
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    };
  }

  function markOffline(error: unknown): void {
    link = {
      state: 'offline',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  async function refresh(): Promise<void> {
    if (closed) return;
    try {
      const info = await client.version();
      if (info.protocolVersion !== SPACE_PROTOCOL_VERSION) {
        link = {
          state: 'error',
          message: `服务端协议版本 ${String(info.protocolVersion)} 与插件 ${String(
            SPACE_PROTOCOL_VERSION,
          )} 不兼容`,
          serverVersion: info.version,
          protocolVersion: info.protocolVersion,
        };
        return;
      }
      if (info.databaseSchemaVersion > SPACE_DB_FORMAT_VERSION) {
        link = {
          state: 'error',
          message: `服务端数据库结构版本 ${String(
            info.databaseSchemaVersion,
          )} 高于插件支持的 ${String(SPACE_DB_FORMAT_VERSION)}`,
          serverVersion: info.version,
          protocolVersion: info.protocolVersion,
        };
        return;
      }
      const wasOffline = link.state !== 'online';
      markOnline(info.version, info.protocolVersion);
      if (wasOffline && counts().pending > 0)
        void flush().catch(() => undefined);
    } catch (error) {
      if (error instanceof RemoteClientError && error.code === 'remote/protocol') {
        link = { state: 'error', message: error.message };
        return;
      }
      const wasOnline = link.state === 'online';
      markOffline(error);
      if (wasOnline || link.message === undefined)
        logger.warn?.(
          `[alter-dsh-space] 服务端不可用：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
    }
  }

  function rememberShadow(result: unknown): void {
    const value = valueOf(result);
    if (!isPlainObject(value)) return;
    const { docId, revision, title, doc } = value as {
      docId?: unknown;
      revision?: unknown;
      title?: unknown;
      doc?: unknown;
    };
    if (
      typeof docId !== 'string' ||
      typeof revision !== 'number' ||
      typeof title !== 'string' ||
      !isPlainObject(doc)
    )
      return;
    // A queued/conflicting write owns the local view until it is replayed or
    // resolved; an online read must not replace it with the older server tree.
    if (cache.hasUnsettled(docId)) return;
    cache.putShadow({
      docId,
      revision,
      title,
      doc: doc as unknown as AlterDoc,
    });
  }

  function applyQueuedWrite(
    endpoint: string,
    input: Record<string, unknown>,
    error: unknown,
    existingKey?: string,
  ): unknown {
    const docId = input.docId;
    if (typeof docId !== 'string') return errorOf(error);
    const shadow = cache.getShadow(docId);
    if (shadow === undefined) {
      return {
        error: {
          code: 'remote/offline-uncached',
          message: '服务端离线，且该文档没有本地缓存，无法保存',
        },
      };
    }
    const baseRevision =
      typeof input.baseRevision === 'number'
        ? input.baseRevision
        : shadow.revision;
    if (baseRevision !== shadow.revision) {
      return {
        error: {
          code: 'doc/conflict',
          message: `文档已在其他设备修改（本地 revision=${String(
            shadow.revision,
          )}）`,
        },
      };
    }
    const ops = Array.isArray(input.ops) ? (input.ops as Operation[]) : [];
    if (endpoint !== 'doc.applyOps' || ops.length === 0)
      return errorOf(error);
    let applied;
    try {
      applied = applyOperations(shadow.doc, ops, {
        docId,
        nowIso: () => now().toISOString(),
        createBlockId: () => `blk_${randomUUID().replaceAll('-', '')}`,
        parseMarkdown: (source, parseOptions) =>
          parseMarkdownBlocks(source, {
            createBlockId: parseOptions.createBlockId,
            hasAsset: (id) => cache.getAsset(id) !== undefined,
          }),
        createObject: () => {
          throw new DocumentError(
            'object/invalid',
            '离线模式下无法创建结构化对象，请恢复连接后重试',
          );
        },
      });
    } catch (applyError) {
      return errorOf(applyError);
    }
    const revision = shadow.revision + 1;
    const nextDoc: AlterDoc = { ...applied.doc, revision };
    const idempotencyKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey !== ''
        ? input.idempotencyKey
        : (existingKey ?? newOutboxIdempotencyKey());
    try {
      cache.enqueue({
        docId,
        endpoint,
        payload: { ...input, baseRevision, idempotencyKey },
        idempotencyKey,
        baseRevision,
        now: now().getTime(),
      });
    } catch (queueError) {
      return errorOf(queueError);
    }
    cache.putShadow({
      docId,
      revision,
      title: shadow.title,
      doc: nextDoc,
    });
    markOffline(error);
    return {
      value: {
        docId,
        revision,
        changedBlockIds: applied.diff.changedBlockIds,
        diff: applied.diff,
        warnings: [],
      },
    };
  }

  /** Apply one successful direct write to an existing shadow snapshot. */
  function syncShadowAfterWrite(endpoint: string, input: Record<string, unknown>, result: unknown): void {
    if (endpoint !== 'doc.applyOps') return;
    const docId = input.docId;
    if (typeof docId !== 'string') return;
    const shadow = cache.getShadow(docId);
    const value = valueOf(result);
    if (shadow === undefined || !isPlainObject(value)) return;
    const revision = (value as { revision?: unknown }).revision;
    if (typeof revision !== 'number') return;
    try {
      const applied = applyOperations(
        shadow.doc,
        Array.isArray(input.ops) ? (input.ops as Operation[]) : [],
        {
          docId,
          nowIso: () => now().toISOString(),
          createBlockId: () => `blk_${randomUUID().replaceAll('-', '')}`,
          parseMarkdown: (source, parseOptions) =>
            parseMarkdownBlocks(source, {
              createBlockId: parseOptions.createBlockId,
              hasAsset: (id) => cache.getAsset(id) !== undefined,
            }),
          createObject: () => {
            throw new DocumentError('object/invalid', '不支持离线对象写入');
          },
        },
      );
      cache.putShadow({
        docId,
        revision,
        title: shadow.title,
        doc: { ...applied.doc, revision },
      });
    } catch {
      cache.deleteShadow(docId);
    }
  }

  async function rpc(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = argsOf(payload);
    const isRead = isReadEndpoint(endpoint);
    if (isRead) {
      try {
        const result = await client.rpc(endpoint, payload, signal);
        if (!isPlainObject(result) || result.error === undefined) {
          cache.setJson(cacheKey(endpoint, args), result);
          if (endpoint === 'doc.get') rememberShadow(result);
        }
        if (link.state !== 'online') markOnline(link.serverVersion, link.protocolVersion);
        return result;
      } catch (error) {
        if (!isTransportError(error)) return errorOf(error);
        markOffline(error);
        if (endpoint === 'doc.get') {
          const docId = typeof args[0] === 'string' ? args[0] : undefined;
          const shadow = docId === undefined ? undefined : cache.getShadow(docId);
          if (shadow !== undefined)
            return { value: shadow };
        }
        const cached = cache.getJson(cacheKey(endpoint, args));
        if (cached !== undefined) return cached;
        return errorOf(error);
      }
    }
    const input = writeInput(payload);
    const queueable =
      endpoint === 'doc.applyOps' &&
      input !== undefined &&
      typeof input.docId === 'string';
    // Ensure a retryable write carries an idempotency key even when the
    // caller never sent one.
    let outgoingPayload = payload;
    let queuedKey: string | undefined;
    if (queueable && input !== undefined) {
      const key =
        typeof input.idempotencyKey === 'string' && input.idempotencyKey !== ''
          ? input.idempotencyKey
          : newOutboxIdempotencyKey();
      queuedKey = key;
      outgoingPayload = isPlainObject(payload)
        ? { ...payload, args: [{ ...input, idempotencyKey: key }, ...args.slice(1)] }
        : payload;
    }
    try {
      const result = await client.rpc(endpoint, outgoingPayload, signal);
      if (!isPlainObject(result) || result.error === undefined) {
        if (queueable && input !== undefined)
          syncShadowAfterWrite(endpoint, input, result);
        markOnline(link.serverVersion, link.protocolVersion);
        lastSyncedAt = now().toISOString();
      }
      return result;
    } catch (error) {
      if (!isTransportError(error)) return errorOf(error);
      markOffline(error);
      if (queueable && input !== undefined)
        return applyQueuedWrite(endpoint, input, error, queuedKey);
      return errorOf(error);
    }
  }

  /** Mark one queue entry as failed without blocking the remaining entries. */
  function failEntry(seq: number, error: unknown): void {
    cache.fail(
      seq,
      error instanceof Error ? error.message : String(error),
      now().getTime(),
    );
  }

  async function flush(): Promise<void> {
    if (closed) return;
    // A migration freeze owns the authority window; replaying queued writes
    // into a database that is being replaced would corrupt the target.
    if (options.pauseFlush?.() === true) return;
    if (flushing !== undefined) {
      queuedRefresh = true;
      return flushing;
    }
    flushing = (async () => {
      try {
        do {
          queuedRefresh = false;
          if (closed) return;
          try {
            const info = await client.version();
            if (info.protocolVersion !== SPACE_PROTOCOL_VERSION) {
              link = { state: 'error', message: '服务端协议版本不兼容' };
              return;
            }
            markOnline(info.version, info.protocolVersion);
          } catch (error) {
            if (
              error instanceof RemoteClientError &&
              error.code === 'remote/protocol'
            ) {
              link = { state: 'error', message: error.message };
              return;
            }
            markOffline(error);
            return;
          }
          for (;;) {
            if (closed) return;
            const entry = cache.nextPending();
            if (entry === undefined) break;
            let server: unknown;
            try {
              server = await client.call<{ docId: string; revision: number }>(
                'doc.get',
                [entry.docId],
              );
            } catch (error) {
              if (isTransportError(error)) {
                markOffline(error);
                return;
              }
              if (isUnauthorizedError(error)) {
                link = { state: 'error', message: '服务端拒绝了 token，请更新 token' };
                return;
              }
              failEntry(entry.seq, error);
              continue;
            }
            const revision =
              isPlainObject(server) && typeof server.revision === 'number'
                ? server.revision
                : undefined;
            if (revision === undefined) {
              failEntry(entry.seq, '服务端返回的文档版本无效');
              continue;
            }
            if (revision !== entry.baseRevision) {
              cache.markConflict(
                entry.docId,
                `文档已在其他设备修改（服务端 revision=${String(revision)}，本地基线=${String(entry.baseRevision)}）`,
                now().getTime(),
              );
              continue;
            }
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(entry.payload) as Record<string, unknown>;
            } catch {
              failEntry(entry.seq, '排队的写入内容已损坏');
              continue;
            }
            try {
              await client.call(entry.endpoint, [payload]);
              cache.remove(entry.seq);
              lastSyncedAt = now().toISOString();
            } catch (error) {
              if (isTransportError(error)) {
                markOffline(error);
                return;
              }
              if (isUnauthorizedError(error)) {
                link = { state: 'error', message: '服务端拒绝了 token，请更新 token' };
                return;
              }
              if (
                error instanceof RemoteClientError &&
                (error.code === 'doc/conflict' ||
                  error.code === 'idempotency/conflict')
              ) {
                cache.markConflict(entry.docId, error.message, now().getTime());
                continue;
              }
              failEntry(entry.seq, error);
              continue;
            }
          }
        } while (queuedRefresh);
      } catch (error) {
        // Closing the cache while a flush is in flight must not surface as an
        // unhandled rejection; queue state remains durable on disk.
        logger.warn?.(
          `[alter-dsh-space] 重放待同步写入失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  // Keep the link fact fresh; refresh() triggers a flush after recovery.
  const heartbeat = setInterval(() => {
    void refresh().catch(() => undefined);
  }, 20_000);
  heartbeat.unref?.();
  // A pending queue found at startup waits for the first link probe.
  if (counts().pending > 0) void flush().catch(() => undefined);

  /**
   * Stamp the Agent actor onto one document write. The server-authority route
   * treats a missing actor as the browser `user`, so every write that crosses
   * the bridge must carry `alter` explicitly (a tool edit must never be
   * recorded as the user's own version).
   */
  const asAgentWrite = <T extends object>(
    input: T,
  ): T & { actor: 'alter' } => ({ ...input, actor: 'alter' });

  const documentPort: DocumentToolApi = {
    outline: (docId) =>
      callDocument('doc.outline', [docId]) as ReturnType<
        DocumentToolApi['outline']
      >,
    read: (docId, readOptions) =>
      callDocument('doc.read', [docId, readOptions]) as ReturnType<
        DocumentToolApi['read']
      >,
    search: (input) =>
      callDocument('doc.search', [input]) as ReturnType<
        DocumentToolApi['search']
      >,
    applyOperations: (input) =>
      callDocument('doc.applyOps', [asAgentWrite(input)]) as ReturnType<
        DocumentToolApi['applyOperations']
      >,
    generate: (input) =>
      callDocument('doc.generate', [asAgentWrite(input)]) as ReturnType<
        DocumentToolApi['generate']
      >,
    undo: (input) =>
      callDocument('doc.undo', [asAgentWrite(input)]) as ReturnType<
        DocumentToolApi['undo']
      >,
    getObject: (objectId) =>
      callDocument('object.get', [objectId]) as ReturnType<
        DocumentToolApi['getObject']
      >,
    updateObject: (input) =>
      callDocument('doc.updateObject', [asAgentWrite(input)]) as ReturnType<
        DocumentToolApi['updateObject']
      >,
  };

  async function callDocument(endpoint: string, args: unknown[]): Promise<unknown> {
    const result = await rpc(endpoint, { op: endpoint, args });
    if (isPlainObject(result)) {
      if (result.error !== undefined) {
        const error = isPlainObject(result.error) ? result.error : {};
        throw new RemoteClientError(
          typeof error.code === 'string' ? error.code : 'remote/failed',
          typeof error.message === 'string'
            ? error.message
            : 'Space 服务请求失败',
        );
      }
      return result.value;
    }
    return result;
  }

  return {
    rpc,
    async fetchAsset(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const assetId = url.searchParams.get('id') ?? '';
      if (assetId === '') {
        return new Response(JSON.stringify({ error: 'missing_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const cached = cache.getAsset(assetId);
      try {
        const response = await client.asset(assetId);
        if (response.ok) {
          const data = new Uint8Array(await response.arrayBuffer());
          const mime =
            response.headers.get('content-type') ?? 'application/octet-stream';
          cache.putAsset(assetId, mime, data);
          markOnline(link.serverVersion, link.protocolVersion);
          return assetResponse(mime, data);
        }
        if (cached !== undefined)
          return assetResponse(cached.mime, cached.data);
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: response.status === 404 ? 404 : 502,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        markOffline(error);
        if (cached !== undefined) return assetResponse(cached.mime, cached.data);
        return new Response(JSON.stringify({ error: 'asset_unavailable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
    document: documentPort,
    assets: {
      async import(input) {
        const result = await callDocument('doc.importAsset', [
          {
            mime: input.mime,
            dataBase64: Buffer.from(input.data).toString('base64'),
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        ]);
        const value = result as {
          assetId: string;
          mime: string;
          bytes: number;
          name?: string;
        };
        return {
          id: value.assetId,
          mime: value.mime,
          bytes: value.bytes,
          ...(value.name === undefined ? {} : { name: value.name }),
        };
      },
    },
    get status() {
      return status();
    },
    refresh,
    flush,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      cache.close();
    },
  };
}

function assetResponse(mime: string, data: Uint8Array): Response {
  // Never trust the remote content type for inline rendering: only known
  // image types stay inline, everything else downloads (same policy as the
  // local asset route) so a compromised server cannot run script in the DSH
  // page origin.
  const inline = isImageMime(mime);
  return new Response(data, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(data.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      ...(inline ? {} : { 'content-disposition': 'attachment' }),
    },
  });
}
