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
import type { BackendConnectionStatus, SpaceToolApi } from '../core/backend.js';
import { isImageMime } from '../document/asset-store.js';
import {
  applyOperations,
} from '../document/ast/operations.js';
import { parseMarkdownBlocks } from '../document/editors/legacy/markdown.js';
import type {
  DocumentToolApi,
  DocumentToolAssetApi,
} from '../document/editors/legacy/tools.js';
import {
  DocumentError,
  type AlterDoc,
  type Operation,
} from '../document/editors/legacy/types.js';
import { isReadEndpoint } from '../authority/endpoints.js';
import { SPACE_PROTOCOL_VERSION } from '../core/protocol.js';
import { SPACE_DB_FORMAT_VERSION } from '../persistence/store.js';
import {
  openRemoteCache,
  newOutboxIdempotencyKey,
  type RemoteCache,
  type ShadowDocument,
} from './cache.js';
import type { RemoteClientOptions } from './client.js';
import {
  RemoteClientError,
  RemoteSpaceClient,
  remoteCodeForStatus,
} from './client.js';

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
  /** Per-request timeout; defaults to the client's 30 seconds. */
  timeoutMs?: number;
  /** Extra gate used by a migration freeze to suspend queue replay. */
  pauseFlush?: () => boolean;
}

/** Heartbeat period while the link is healthy. */
const ONLINE_HEARTBEAT_MS = 20_000;
/** First retry delay while the link is down; doubles up to the cap. */
const OFFLINE_HEARTBEAT_BASE_MS = 20_000;
/** Cap for the offline heartbeat backoff. */
const OFFLINE_HEARTBEAT_MAX_MS = 5 * 60_000;

/**
 * Document writes whose actor ALSO travels inline on the first argument:
 * offline queue rows store that argument and replay it verbatim, so the
 * provenance must survive inside the stored input. Every other write carries
 * the stamp on the envelope only.
 */
const ACTOR_ENDPOINTS: ReadonlySet<string> = new Set([
  'doc.applyOps',
  'doc.undo',
  'doc.restoreVersion',
  'doc.generate',
  'doc.updateObject',
]);

/**
 * Stamp the authoritative origin onto the payload envelope. Applied to EVERY
 * crossing payload (reads included) so a browser body can never choose its
 * own actor: the stamp overwrites any caller-supplied value, and the server
 * route is passthrough that selects the identity stack from this stamp.
 */
function stampEnvelope(payload: unknown, actor: 'user' | 'alter'): unknown {
  if (!isPlainObject(payload)) return payload;
  return { ...payload, actor };
}

/** Stamp the actor inline on the first argument (document-write replays). */
function stampActor(payload: unknown, actor: 'user' | 'alter'): unknown {
  if (!isPlainObject(payload)) return payload;
  const args = argsOf(payload);
  if (args.length === 0 || !isPlainObject(args[0])) return payload;
  return { ...payload, args: [{ ...args[0], actor }, ...args.slice(1)] };
}

/**
 * Non-document writes carry identity on the envelope only: strip any
 * caller-supplied inline actor so a forged value never crosses the hop.
 */
function stripInlineActor(payload: unknown): unknown {
  if (!isPlainObject(payload)) return payload;
  const args = argsOf(payload);
  if (args.length === 0 || !isPlainObject(args[0]) || args[0].actor === undefined)
    return payload;
  const cleaned = { ...args[0] };
  delete cleaned.actor;
  return { ...payload, args: [cleaned, ...args.slice(1)] };
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
 * One document with queued writes that have not reached the server.
 * The settings page renders one row per document and offers retry/discard.
 */
export interface SyncQueueEntry {
  docId: string;
  /** `pending` waits for the link; the others need a user decision. */
  state: 'pending' | 'conflict' | 'failed';
  /** Number of queue entries for this document. */
  entries: number;
  baseRevision: number;
  /** Last failure message, when the server rejected a replay. */
  lastError?: string;
  updatedAt: string;
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
  /** Agent Space structure port; writes are stamped `alter` across the hop. */
  readonly space: SpaceToolApi;
  readonly assets: DocumentToolAssetApi;
  readonly status: BackendConnectionStatus;
  /** Documents whose queued writes are unsettled, one row per document. */
  queueEntries(): SyncQueueEntry[];
  /** Retry or discard one document's unsettled writes (explicit user action). */
  resolveQueue(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<{ resolved: number }>;
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
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const client = new RemoteSpaceClient(clientOptions);
  const cache: RemoteCache = openRemoteCache(
    options.directory,
    options.baseUrl,
    options.logger,
  );
  let link: BackendConnectionStatus = { state: 'connecting' };
  let lastSyncedAt: string | undefined;
  let closed = false;
  let flushing: Promise<void> | undefined;
  let queuedRefresh = false;
  /** Cache keys with a background revalidation already in flight. */
  const revalidating = new Set<string>();

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
      // Preserve previously learned facts: a refresh without a version
      // answer must not make the settings page forget the server version.
      ...((version ?? (link.serverVersion)) === undefined
        ? {}
        : { serverVersion: version ?? link.serverVersion }),
      ...((protocolVersion ?? link.protocolVersion) === undefined
        ? {}
        : { protocolVersion: protocolVersion ?? link.protocolVersion }),
    };
  }

  function markOffline(error: unknown): void {
    link = {
      state: 'offline',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * The best cached answer for one read, without touching the network.
   *
   * `doc.get` prefers the shadow: it is the local document tree including
   * queued optimistic edits, while the cached raw response is the older
   * server snapshot.
   */
  function cachedRead(
    endpoint: string,
    args: unknown[],
    key: string,
  ): unknown | undefined {
    if (endpoint === 'doc.get') {
      const docId = typeof args[0] === 'string' ? args[0] : undefined;
      const shadow = docId === undefined ? undefined : cache.getShadow(docId);
      if (shadow !== undefined) return { value: shadow };
    }
    return cache.getJson(key);
  }

  /**
   * Refresh one cached read in the background (stale-while-revalidate).
   *
   * Only one revalidation per cache key runs at a time, so a panel that keeps
   * polling while offline cannot pile up requests; the next read after it
   * completes serves the fresher value.
   */
  function scheduleRevalidate(
    endpoint: string,
    payload: unknown,
    key: string,
  ): void {
    if (closed || revalidating.has(key)) return;
    revalidating.add(key);
    void (async () => {
      try {
        const result = await client.rpc(endpoint, payload);
        if (closed) return;
        if (!isPlainObject(result) || result.error === undefined) {
          cache.setJson(key, result);
          if (endpoint === 'doc.get') rememberShadow(result);
        }
        markOnline(link.serverVersion, link.protocolVersion);
      } catch (error) {
        if (closed) return;
        if (isTransportError(error)) markOffline(error);
        else if (isUnauthorizedError(error))
          link = { state: 'error', message: '服务端拒绝了 token，请更新 token' };
      } finally {
        revalidating.delete(key);
      }
    })();
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

  /**
   * Fetch the authoritative document and store it as the local shadow.
   *
   * This is the only way a shadow is refreshed against the server, so the
   * local view always matches a real server revision. A stale local tree is
   * never used to reconstruct it.
   */
  async function refreshShadow(docId: string): Promise<ShadowDocument | undefined> {
    let result: unknown;
    try {
      result = await client.call<{ docId: string; revision: number; title: string; doc: unknown }>(
        'doc.get',
        [docId],
      );
    } catch (error) {
      if (isTransportError(error) || isUnauthorizedError(error)) return undefined;
      // A deleted document has no shadow to keep.
      cache.deleteShadow(docId);
      return undefined;
    }
    if (!isPlainObject(result)) return undefined;
    const { revision, title, doc } = result as {
      revision?: unknown;
      title?: unknown;
      doc?: unknown;
    };
    if (typeof revision !== 'number' || typeof title !== 'string' || !isPlainObject(doc))
      return undefined;
    if (cache.hasUnsettled(docId)) {
      // A queued/conflicting write owns the local view until it is replayed or
      // resolved; an online read must not replace it with the older tree.
      const existing = cache.getShadow(docId);
      if (existing !== undefined) return existing;
    }
    const shadow: ShadowDocument = {
      docId,
      revision,
      title,
      doc: doc as unknown as AlterDoc,
    };
    cache.putShadow(shadow);
    return shadow;
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

  /**
   * Queue one document write that could not reach the server.
   *
   * The optimistic tree is produced by applying the batch to the local
   * shadow. `rpc` refreshes that shadow from the server before falling back
   * here, so a first edit on a fresh link or on a document never read on this
   * device normally has a usable baseline; `offline-uncached` is reserved for
   * the case where the server stayed unreachable through that retry.
   */
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
      // The queue row and the optimistic shadow are one transaction: the
      // successful answer below must never exist without a durable replay.
      cache.enqueue(
        {
          docId,
          endpoint,
          payload: { ...input, baseRevision, idempotencyKey },
          idempotencyKey,
          baseRevision,
          now: now().getTime(),
        },
        { docId, revision, title: shadow.title, doc: nextDoc },
      );
    } catch (queueError) {
      return errorOf(queueError);
    }
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

  /**
   * Refresh the local shadow after one successful direct write.
   *
   * The write answer only carries the new revision, not the resulting tree,
   * so the shadow must be rebuilt from the server document. Re-applying the
   * batch to the old local tree produced a shadow that looked current
   * (same revision) but silently dropped every concurrent edit made by
   * another device; when the refresh fails the shadow is removed instead of
   * being left with a stale tree.
   */
  async function syncShadowAfterWrite(endpoint: string, input: Record<string, unknown>): Promise<void> {
    if (endpoint !== 'doc.applyOps') return;
    const docId = input.docId;
    if (typeof docId !== 'string') return;
    // A queued or conflicting entry owns the local view; re-reading the
    // server now would throw that pending content away.
    if (cache.hasUnsettled(docId)) return;
    const shadow = await refreshShadow(docId);
    if (shadow === undefined) cache.deleteShadow(docId);
  }

  /**
   * Dispatch one call for a known origin.
   *
   * `origin` is not client input: the browser-facing route calls {@link rpc}
   * (always `user`) and the Agent document port calls with `alter`. The server
   * route is passthrough, so this is the only place that can keep provenance
   * honest across the server hop.
   */
  async function dispatch(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    origin: 'user' | 'alter',
  ): Promise<unknown> {
    // Provenance is decided here, once, for every endpoint: the envelope
    // stamp overwrites anything the caller claimed. Reads carry it too so a
    // forged envelope actor cannot select a stack on the server either.
    const stamped = stampEnvelope(payload, origin);
    const isRead = isReadEndpoint(endpoint);
    if (isRead) {
      const args = argsOf(stamped);
      const key = cacheKey(endpoint, args);
      const cached = cachedRead(endpoint, args, key);
      if (cached !== undefined && link.state !== 'online') {
        // Stale-while-revalidate: with the link down, a cached answer is
        // served immediately instead of blocking on the 30s request timeout.
        scheduleRevalidate(endpoint, stamped, key);
        return cached;
      }
      try {
        const result = await client.rpc(endpoint, stamped, signal);
        if (!isPlainObject(result) || result.error === undefined) {
          cache.setJson(key, result);
          if (endpoint === 'doc.get') rememberShadow(result);
        }
        if (link.state !== 'online')
          markOnline(link.serverVersion, link.protocolVersion);
        return result;
      } catch (error) {
        if (!isTransportError(error)) return errorOf(error);
        markOffline(error);
        const fallback = cachedRead(endpoint, args, key);
        if (fallback !== undefined) return fallback;
        return errorOf(error);
      }
    }
    const args = argsOf(stamped);
    const outgoing = ACTOR_ENDPOINTS.has(endpoint)
      ? stampActor(stamped, origin)
      : stripInlineActor(stamped);
    const input = writeInput(outgoing);
    const queueable =
      endpoint === 'doc.applyOps' &&
      input !== undefined &&
      typeof input.docId === 'string';
    // Ensure a retryable write carries an idempotency key even when the
    // caller never sent one.
    let outgoingPayload = outgoing;
    let queuedKey: string | undefined;
    if (queueable && input !== undefined) {
      const key =
        typeof input.idempotencyKey === 'string' && input.idempotencyKey !== ''
          ? input.idempotencyKey
          : newOutboxIdempotencyKey();
      queuedKey = key;
      outgoingPayload = isPlainObject(outgoing)
        ? { ...outgoing, args: [{ ...input, idempotencyKey: key }, ...args.slice(1)] }
        : outgoing;
    }
    try {
      const result = await client.rpc(endpoint, outgoingPayload, signal);
      if (!isPlainObject(result) || result.error === undefined) {
        if (queueable && input !== undefined)
          await syncShadowAfterWrite(endpoint, input);
        markOnline(link.serverVersion, link.protocolVersion);
        lastSyncedAt = now().toISOString();
      }
      return result;
    } catch (error) {
      if (!isTransportError(error)) return errorOf(error);
      markOffline(error);
      if (queueable && input !== undefined && typeof input.docId === 'string') {
        const docId = input.docId;
        // Without a shadow the queued batch has no baseline to apply to. One
        // more attempt to read the document covers the common "the link just
        // dropped before this device ever opened the doc" case.
        if (cache.getShadow(docId) === undefined && !cache.hasUnsettled(docId))
          await refreshShadow(docId);
        return applyQueuedWrite(endpoint, input, error, queuedKey);
      }
      return errorOf(error);
    }
  }

  /** Browser-originated call: document writes are always attributed to `user`. */
  async function rpc(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return dispatch(endpoint, payload, signal, 'user');
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
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(entry.payload) as Record<string, unknown>;
            } catch {
              failEntry(entry.seq, '排队的写入内容已损坏');
              continue;
            }
            if (!isPlainObject(payload)) {
              failEntry(entry.seq, '排队的写入内容已损坏');
              continue;
            }
            // Replay the stored request first, without a doc.get pre-check:
            // the server checks the idempotency key before the base revision,
            // so a write that was applied but whose response was lost is
            // acknowledged by replay instead of being mistaken for a conflict
            // against the newer revision its own first attempt created.
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
              // A capacity answer (503 while a migration freezes the server,
              // or while it is shutting down) is not a decision about this
              // write: parking it as `failed` would demand a manual retry for
              // content that is perfectly valid. Keep it pending and stop the
              // drain; the heartbeat or the next flush retries it.
              if (
                error instanceof RemoteClientError &&
                error.status !== undefined &&
                error.status >= 500
              ) {
                markOffline(error);
                return;
              }
              // Only a genuine business conflict needs the user's decision;
              // every other rejection fails just this entry.
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
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let offlineProbes = 0;

  /**
   * Heartbeat delay: fast while online, exponential backoff with jitter while
   * offline, so a long outage neither hammers the server nor keeps every
   * plugin probing in lockstep.
   */
  function heartbeatDelay(): number {
    if (link.state === 'online') {
      offlineProbes = 0;
      return ONLINE_HEARTBEAT_MS;
    }
    const exponent = Math.min(offlineProbes, 6);
    offlineProbes += 1;
    const base = Math.min(
      OFFLINE_HEARTBEAT_MAX_MS,
      OFFLINE_HEARTBEAT_BASE_MS * 2 ** exponent,
    );
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  function scheduleHeartbeat(): void {
    if (closed) return;
    heartbeatTimer = setTimeout(() => {
      void refresh()
        .catch(() => undefined)
        .finally(() => scheduleHeartbeat());
    }, heartbeatDelay());
    heartbeatTimer.unref?.();
  }

  scheduleHeartbeat();
  // A pending queue found at startup waits for the first link probe.
  if (counts().pending > 0) void flush().catch(() => undefined);

  /**
   * Agent tool port. Every call goes through `dispatch(..., 'alter')`, so a
   * tool edit is attributed to the Agent even though the standalone server
   * route only sees the bridge as its caller.
   */
  const documentPort: DocumentToolApi = {
    outline: (docId) =>
      callAlter('doc.outline', [docId]) as ReturnType<
        DocumentToolApi['outline']
      >,
    read: (docId, readOptions) =>
      callAlter('doc.read', [docId, readOptions]) as ReturnType<
        DocumentToolApi['read']
      >,
    search: (input) =>
      callAlter('doc.search', [input]) as ReturnType<
        DocumentToolApi['search']
      >,
    applyOperations: (input) =>
      callAlter('doc.applyOps', [input]) as ReturnType<
        DocumentToolApi['applyOperations']
      >,
    generate: (input) =>
      callAlter('doc.generate', [input]) as ReturnType<
        DocumentToolApi['generate']
      >,
    undo: (input) =>
      callAlter('doc.undo', [input]) as ReturnType<
        DocumentToolApi['undo']
      >,
    getObject: (objectId) =>
      callAlter('object.get', [objectId]) as ReturnType<
        DocumentToolApi['getObject']
      >,
    updateObject: (input) =>
      callAlter('doc.updateObject', [input]) as ReturnType<
        DocumentToolApi['updateObject']
      >,
  };

  async function callAlter(endpoint: string, args: unknown[]): Promise<unknown> {
    const result = await dispatch(endpoint, { op: endpoint, args }, undefined, 'alter');
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

  /**
   * Agent Space structure port. Reads take the existing cache path; writes
   * are stamped `alter` and, unlike browser document edits, are never queued:
   * offline structure writes fail explicitly (`remote/unavailable`), the same
   * semantics the browser sees for uncached operations.
   */
  const spacePort: SpaceToolApi = {
    listSpaces: () => callAlter('space.listSpaces', []) as ReturnType<SpaceToolApi['listSpaces']>,
    getSpace: (id) => callAlter('space.getSpace', [id]) as ReturnType<SpaceToolApi['getSpace']>,
    listArchivedSpaces: () =>
      callAlter('space.listArchivedSpaces', []) as ReturnType<SpaceToolApi['listArchivedSpaces']>,
    listNodes: (spaceId) =>
      callAlter('space.listNodes', [spaceId]) as ReturnType<SpaceToolApi['listNodes']>,
    getNode: (id) => callAlter('space.getNode', [id]) as ReturnType<SpaceToolApi['getNode']>,
    search: (spaceId, query) =>
      callAlter('space.search', [spaceId, query]) as ReturnType<SpaceToolApi['search']>,
    getOverview: (spaceId) =>
      callAlter('space.getOverview', [spaceId]) as ReturnType<SpaceToolApi['getOverview']>,
    listDeleted: (spaceId) =>
      callAlter('space.listDeleted', [spaceId]) as ReturnType<SpaceToolApi['listDeleted']>,
    createNode: (input) =>
      callAlter('space.createNode', [input]) as ReturnType<SpaceToolApi['createNode']>,
    saveNode: (id, patch) =>
      callAlter('space.saveNode', [id, patch]) as ReturnType<SpaceToolApi['saveNode']>,
    moveNode: (id, target) =>
      callAlter('space.moveNode', [id, target]) as ReturnType<SpaceToolApi['moveNode']>,
    setPinned: (id, pinned) =>
      callAlter('space.setPinned', [id, pinned]) as ReturnType<SpaceToolApi['setPinned']>,
    setArchived: (id, archived) =>
      callAlter('space.setArchived', [id, archived]) as ReturnType<SpaceToolApi['setArchived']>,
    deleteNode: (id) =>
      callAlter('space.deleteNode', [id]) as ReturnType<SpaceToolApi['deleteNode']>,
    restoreNode: (id) =>
      callAlter('space.restoreNode', [id]) as ReturnType<SpaceToolApi['restoreNode']>,
  };

  /**
   * List the documents whose queued writes have not reached the server.
   * One row per document so the settings page can offer one action per doc.
   */
  function queueEntries(): SyncQueueEntry[] {
    const grouped = new Map<string, SyncQueueEntry>();
    for (const entry of cache.listUnsettled()) {
      const existing = grouped.get(entry.docId);
      const state: SyncQueueEntry['state'] =
        entry.state === 'pending'
          ? 'pending'
          : entry.state === 'conflict'
            ? 'conflict'
            : 'failed';
      if (existing === undefined) {
        grouped.set(entry.docId, {
          docId: entry.docId,
          state,
          entries: 1,
          baseRevision: entry.baseRevision,
          ...(entry.lastError === null ? {} : { lastError: entry.lastError }),
          updatedAt: new Date(entry.updatedAt).toISOString(),
        });
        continue;
      }
      existing.entries += 1;
      // A document with any conflict or failure is not merely pending.
      if (state !== 'pending') existing.state = state;
      if (entry.lastError !== null) existing.lastError = entry.lastError;
      if (entry.updatedAt > new Date(existing.updatedAt).getTime())
        existing.updatedAt = new Date(entry.updatedAt).toISOString();
    }
    return [...grouped.values()];
  }

  /**
   * Resolve one document's unsettled queue entries.
   *
   * `retry` re-arms conflicts/failures against the server's current revision
   * and replays; `discard` drops the pending content and its shadow so the
   * next read comes from the server. Both are explicit user decisions: the
   * bridge never resolves a conflict on its own.
   */
  async function resolveQueue(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<{ resolved: number }> {
    if (action === 'discard') {
      const resolved = cache.discard(docId);
      // Drop every cached read that belongs to this document, not just
      // doc.get: outline/read/versions would otherwise keep serving the
      // discarded local content after the shadow is gone.
      cache.deleteKeysContaining(JSON.stringify(docId));
      return { resolved };
    }
    let revision: number | undefined;
    try {
      const server = await client.call<{ revision?: unknown }>('doc.get', [docId]);
      if (isPlainObject(server) && typeof server.revision === 'number')
        revision = server.revision;
    } catch (error) {
      // Preserve the underlying code (401, protocol, business) instead of
      // flattening every failure into "unavailable": the settings surface
      // shows "repair the token" differently from "the link is down".
      if (error instanceof RemoteClientError) {
        if (isTransportError(error)) {
          markOffline(error);
          throw new RemoteClientError(
            error.code,
            `重试需要连接服务端以确认最新版本；请恢复连接后重试（${error.message}）`,
          );
        }
        if (isUnauthorizedError(error))
          link = { state: 'error', message: '服务端拒绝了 token，请更新 token' };
        throw error;
      }
      markOffline(error);
      throw new RemoteClientError(
        'remote/unavailable',
        `重试需要连接服务端以确认最新版本；请恢复连接后重试（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
    if (revision === undefined)
      throw new RemoteClientError('remote/protocol', '服务端返回的文档版本无效');
    const resolved = cache.requeue(docId, revision, now().getTime());
    markOnline(link.serverVersion, link.protocolVersion);
    await flush();
    return { resolved };
  }

  return {
    rpc,
    queueEntries,
    resolveQueue,
    async fetchAsset(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const assetId = url.searchParams.get('id') ?? '';
      if (assetId === '') {
        return new Response(JSON.stringify({ error: 'missing_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Content-addressed assets are immutable, so a cached copy can never be
      // stale: serve it without waiting for the network at all.
      const cached = cache.getAsset(assetId);
      if (cached !== undefined) return assetResponse(cached.mime, cached.data);
      let response: Response;
      try {
        response = await client.asset(assetId, request.signal);
      } catch (error) {
        // A browser-cancelled asset request says nothing about the link.
        if (!request.signal.aborted) markOffline(error);
        return assetUnavailable();
      }
      if (response.ok) {
        try {
          const data = new Uint8Array(await response.arrayBuffer());
          const mime =
            response.headers.get('content-type') ?? 'application/octet-stream';
          cache.putAsset(assetId, mime, data);
          markOnline(link.serverVersion, link.protocolVersion);
          return assetResponse(mime, data);
        } catch {
          // The body was cut off after the headers; the link is flaky, not
          // the asset. Do not cache a partial body.
          markOffline(new Error('读取资产响应体失败'));
          return assetUnavailable();
        }
      }
      const code = remoteCodeForStatus(response.status);
      if (code === 'remote/unavailable') {
        markOffline(
          new RemoteClientError(
            code,
            `Space 服务端资产接口暂时不可用（HTTP ${String(response.status)}）`,
            response.status,
          ),
        );
        return assetUnavailable();
      }
      if (code === 'remote/unauthorized')
        link = { state: 'error', message: '服务端拒绝了 token，请更新 token' };
      if (response.status === 404)
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      // 404/405 and other non-auth 4xx mean the asset route is wrong, not that
      // the link is down; report a bad gateway without claiming offline.
      return new Response(JSON.stringify({ error: 'asset_unavailable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    },
    document: documentPort,
    space: spacePort,
    assets: {
      async import(input) {
        const result = await callAlter('doc.importAsset', [
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
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      cache.close();
    },
  };
}

/** One stable 502 body for an asset that could not be served right now. */
function assetUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'asset_unavailable' }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  });
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
