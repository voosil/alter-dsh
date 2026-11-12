/**
 * Local read cache and durable write queue for the server-authority mode.
 *
 * The cache database is disposable local state (never the authority): document
 * snapshots, read responses, immutable asset bytes, and the outbox that keeps
 * document edits durable while the server link is down. It lives beside the
 * local Space data directory and is recreated if its schema is unknown.
 *
 * @module @alter-dsh/space/remote/cache
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AlterDoc } from '../document/editors/legacy/types.js';

/** Bump when the disposable cache layout changes; old files are recreated. */
const CACHE_SCHEMA_VERSION = 1;
/** Maximum cached read responses before the oldest rows are pruned. */
const CACHE_ROW_LIMIT = 500;
/** Asset bytes above this bound are streamed but not cached locally. */
export const MAX_CACHED_ASSET_BYTES = 16 * 1024 * 1024;
/** Total bytes the content-addressed asset cache may hold before eviction. */
export const MAX_CACHED_ASSET_TOTAL_BYTES = 256 * 1024 * 1024;
/** Durable document writes waiting for one server; refuse unbounded growth. */
export const MAX_OUTBOX_ENTRIES = 2_000;

/** One document snapshot used to apply queued edits optimistically. */
export interface ShadowDocument {
  docId: string;
  revision: number;
  title: string;
  doc: AlterDoc;
}

/** One queued document write. */
export interface OutboxEntry {
  seq: number;
  docId: string;
  endpoint: string;
  /** JSON string of the business input (`{ docId, baseRevision, ops, ... }`). */
  payload: string;
  idempotencyKey: string;
  baseRevision: number;
  state: 'pending' | 'conflict' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Queue health facts shown by the settings surface. */
export interface QueueCounts {
  pending: number;
  conflicts: number;
  failed: number;
}

/**
 * One open disposable cache/outbox database.
 */
export interface RemoteCache {
  readonly file: string;
  getJson(key: string): unknown | undefined;
  setJson(key: string, value: unknown): void;
  deleteMatching(pattern: string): void;
  getShadow(docId: string): ShadowDocument | undefined;
  putShadow(shadow: ShadowDocument): void;
  deleteShadow(docId: string): void;
  getAsset(assetId: string): { mime: string; data: Uint8Array } | undefined;
  putAsset(assetId: string, mime: string, data: Uint8Array): void;
  enqueue(entry: {
    docId: string;
    endpoint: string;
    payload: unknown;
    idempotencyKey: string;
    baseRevision: number;
    now: number;
  }): number;
  nextPending(): OutboxEntry | undefined;
  pendingFor(docId: string): OutboxEntry[];
  counts(): QueueCounts;
  /** Documents with at least one unsettled queue entry, oldest first. */
  listUnsettled(): OutboxEntry[];
  markConflict(docId: string, message: string, now: number): void;
  fail(seq: number, message: string, now: number): void;
  remove(seq: number): void;
  touch(seq: number, now: number): void;
  clearConflicts(docId: string): void;
  /**
   * Re-arm every conflict/failed entry of one document for replay against a
   * fresh baseline. The caller is responsible for lowering `base_revision`
   * once the server's current revision is known.
   */
  requeue(docId: string, baseRevision: number, now: number): number;
  /** Drop every queue entry and the shadow of one document. */
  discard(docId: string): number;
  /** Whether one document has pending/conflict/failed writes. */
  hasUnsettled(docId: string): boolean;
  close(): void;
}

interface CacheRow {
  value: string;
}

function rowToEntry(row: Record<string, unknown>): OutboxEntry {
  return {
    seq: Number(row.seq),
    docId: String(row.doc_id),
    endpoint: String(row.endpoint),
    payload: String(row.payload),
    idempotencyKey: String(row.idempotency_key),
    baseRevision: Number(row.base_revision),
    state:
      row.state === 'conflict' || row.state === 'failed'
        ? row.state
        : 'pending',
    attempts: Number(row.attempts),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Recreate the disposable tables after a layout change.
 *
 * The outbox is deliberately *not* dropped: its rows are user content that
 * has not reached the authority yet, and a cache-format bump must never
 * silently lose them. When the stored row layout is unknowable the surviving
 * rows are marked `failed` so the user can retry or discard them instead of
 * having them replayed against a different schema.
 */
function recreateDisposableTables(db: DatabaseSync, previous: number): void {
  for (const table of ['cache', 'asset', 'doc_shadow', 'sync_state']) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const hasOutbox =
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='outbox'")
      .get() !== undefined;
  if (hasOutbox && previous !== CACHE_SCHEMA_VERSION) {
    db.exec("ALTER TABLE outbox RENAME TO outbox_legacy");
    db.exec('PRAGMA user_version = 0');
    createTables(db);
    db.exec(`
      INSERT INTO outbox
        (doc_id, endpoint, payload, idempotency_key, base_revision,
         state, attempts, last_error, created_at, updated_at)
      SELECT doc_id, endpoint, payload, idempotency_key, base_revision,
             'failed', attempts,
             '缓存结构升级后需人工确认重放', created_at, updated_at
      FROM outbox_legacy
    `);
    db.exec('DROP TABLE outbox_legacy');
    return;
  }
  if (hasOutbox && previous === CACHE_SCHEMA_VERSION) {
    // Same layout: keep every row untouched.
    createTables(db);
    return;
  }
  db.exec('DROP TABLE IF EXISTS outbox');
  createTables(db);
}

function createTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_shadow (
      doc_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  const version = Number(
    (
      db.prepare('PRAGMA user_version').get() as { user_version?: unknown }
    ).user_version ?? 0,
  );
  if (version !== CACHE_SCHEMA_VERSION) {
    recreateDisposableTables(db, version);
    db.exec(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION}`);
    return db;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_shadow (
      doc_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

/** File name for one server identity ('' keeps the legacy single-server file). */
export function cacheFileName(scope: string): string {
  if (scope === '') return 'remote-cache.db';
  const digest = createHash('sha256').update(scope, 'utf8').digest('hex');
  return `remote-cache-${digest.slice(0, 12)}.db`;
}

/**
 * Open (or create) the disposable cache beside one Space data directory.
 * A server-scoped file keeps read cache and queued writes for different
 * servers apart instead of replaying one server's queue into another.
 * @param directory - local Space data directory.
 * @param scope - server URL identity (empty for the legacy single-server file).
 */
export function openRemoteCache(
  directory: string,
  scope = '',
): RemoteCache {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, cacheFileName(scope));
  const db = openDatabase(file);
  let closed = false;
  /** Running byte total of the asset table (see `putAsset`). */
  let assetBytes = 0;

  function prune(): void {
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM cache').get() as { c: number }
    ).c;
    if (count <= CACHE_ROW_LIMIT) return;
    db.prepare(
      `DELETE FROM cache WHERE key IN (
         SELECT key FROM cache ORDER BY updated_at ASC LIMIT ?
       )`,
    ).run(count - CACHE_ROW_LIMIT);
  }

  return {
    file,
    getJson(key) {
      const row = db
        .prepare('SELECT value FROM cache WHERE key = ?')
        .get(key) as CacheRow | undefined;
      if (row === undefined) return undefined;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return undefined;
      }
    },
    setJson(key, value) {
      db.prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, JSON.stringify(value), Date.now());
      prune();
    },
    deleteMatching(pattern) {
      db.prepare('DELETE FROM cache WHERE key LIKE ?').run(pattern);
    },
    getShadow(docId) {
      const row = db
        .prepare(
          'SELECT revision, title, doc_json FROM doc_shadow WHERE doc_id = ?',
        )
        .get(docId) as
        | { revision: number; title: string; doc_json: string }
        | undefined;
      if (row === undefined) return undefined;
      try {
        return {
          docId,
          revision: Number(row.revision),
          title: row.title,
          doc: JSON.parse(row.doc_json) as AlterDoc,
        };
      } catch {
        return undefined;
      }
    },
    putShadow(shadow) {
      db.prepare(
        `INSERT INTO doc_shadow (doc_id, revision, title, doc_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET
           revision = excluded.revision,
           title = excluded.title,
           doc_json = excluded.doc_json,
           updated_at = excluded.updated_at`,
      ).run(
        shadow.docId,
        shadow.revision,
        shadow.title,
        JSON.stringify(shadow.doc),
        Date.now(),
      );
    },
    deleteShadow(docId) {
      db.prepare('DELETE FROM doc_shadow WHERE doc_id = ?').run(docId);
    },
    getAsset(assetId) {
      const row = db
        .prepare('SELECT mime, data FROM asset WHERE id = ?')
        .get(assetId) as { mime: string; data: Uint8Array } | undefined;
      if (row === undefined) return undefined;
      return { mime: row.mime, data: row.data };
    },
    putAsset(assetId, mime, data) {
      if (data.byteLength > MAX_CACHED_ASSET_BYTES) return;
      // The running total avoids a full-table SUM on every asset fetch.
      const existing =
        (
          db.prepare('SELECT bytes FROM asset WHERE id = ?').get(assetId) as
            | { bytes: number }
            | undefined
        )?.bytes ?? 0;
      let total = assetBytes;
      if (existing === 0) {
        // First row here (or a value lost to a crash): trust the stored sum.
        total =
          total > 0
            ? total
            : Number(
                (
                  db
                    .prepare('SELECT COALESCE(SUM(bytes), 0) AS c FROM asset')
                    .get() as { c: number }
                ).c,
              );
      }
      const projected = total - Number(existing) + data.byteLength;
      if (projected > MAX_CACHED_ASSET_TOTAL_BYTES) {
        // Evict the oldest cached assets until the new row fits the budget.
        let over = projected - MAX_CACHED_ASSET_TOTAL_BYTES;
        const oldest = db
          .prepare('SELECT id, bytes FROM asset ORDER BY updated_at ASC')
          .all() as { id: string; bytes: number }[];
        const drop = db.prepare('DELETE FROM asset WHERE id = ?');
        for (const row of oldest) {
          if (over <= 0) break;
          if (row.id === assetId) continue;
          drop.run(row.id);
          over -= Number(row.bytes);
          total -= Number(row.bytes);
        }
      }
      db.prepare(
        `INSERT INTO asset (id, mime, bytes, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mime = excluded.mime, bytes = excluded.bytes,
           data = excluded.data, updated_at = excluded.updated_at`,
      ).run(assetId, mime, data.byteLength, data, Date.now());
      assetBytes = Math.max(0, total - Number(existing) + data.byteLength);
    },
    enqueue(entry) {
      const total = (
        db
          .prepare("SELECT COUNT(*) AS c FROM outbox WHERE state IN ('pending','conflict','failed')")
          .get() as { c: number }
      ).c;
      if (total >= MAX_OUTBOX_ENTRIES)
        throw new Error(
          '待同步的本地写入过多，无法继续离线保存；请先恢复与服务端的连接',
        );
      const result = db
        .prepare(
          `INSERT INTO outbox
             (doc_id, endpoint, payload, idempotency_key, base_revision,
              state, attempts, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        )
        .run(
          entry.docId,
          entry.endpoint,
          JSON.stringify(entry.payload),
          entry.idempotencyKey,
          entry.baseRevision,
          entry.now,
          entry.now,
        );
      return Number(result.lastInsertRowid);
    },
    nextPending() {
      const row = db
        .prepare(
          `SELECT * FROM outbox WHERE state = 'pending' ORDER BY doc_id, seq LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;
      return row === undefined ? undefined : rowToEntry(row);
    },
    pendingFor(docId) {
      return (
        db
          .prepare(
            `SELECT * FROM outbox WHERE doc_id = ? AND state = 'pending' ORDER BY seq`,
          )
          .all(docId) as Record<string, unknown>[]
      ).map(rowToEntry);
    },
    counts() {
      const rows = db
        .prepare(
          `SELECT state, COUNT(*) AS c FROM outbox GROUP BY state`,
        )
        .all() as { state: string; c: number }[];
      const counts: QueueCounts = { pending: 0, conflicts: 0, failed: 0 };
      for (const row of rows) {
        if (row.state === 'conflict') counts.conflicts = Number(row.c);
        else if (row.state === 'failed') counts.failed = Number(row.c);
        else counts.pending += Number(row.c);
      }
      return counts;
    },
    markConflict(docId, message, now) {
      db.prepare(
        `UPDATE outbox SET state = 'conflict', last_error = ?, updated_at = ?
         WHERE doc_id = ? AND state = 'pending'`,
      ).run(message, now, docId);
    },
    fail(seq, message, now) {
      db.prepare(
        `UPDATE outbox SET state = 'failed', attempts = attempts + 1,
           last_error = ?, updated_at = ? WHERE seq = ?`,
      ).run(message, now, seq);
    },
    remove(seq) {
      db.prepare('DELETE FROM outbox WHERE seq = ?').run(seq);
    },
    touch(seq, now) {
      db.prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error = NULL,
           updated_at = ? WHERE seq = ?`,
      ).run(now, seq);
    },
    clearConflicts(docId) {
      db.prepare('DELETE FROM outbox WHERE doc_id = ?').run(docId);
      db.prepare('DELETE FROM doc_shadow WHERE doc_id = ?').run(docId);
    },
    listUnsettled() {
      return (
        db
          .prepare(
            `SELECT * FROM outbox WHERE state IN ('pending','conflict','failed')
             ORDER BY doc_id, seq`,
          )
          .all() as Record<string, unknown>[]
      ).map(rowToEntry);
    },
    requeue(docId, baseRevision, now) {
      const result = db
        .prepare(
          `UPDATE outbox
              SET state = 'pending', base_revision = ?, attempts = 0,
                  last_error = NULL, updated_at = ?
            WHERE doc_id = ? AND state IN ('conflict','failed')`,
        )
        .run(baseRevision, now, docId);
      // A requeued document must not keep showing a stale optimistic tree.
      db.prepare('DELETE FROM doc_shadow WHERE doc_id = ?').run(docId);
      return Number(result.changes);
    },
    discard(docId) {
      const result = db.prepare('DELETE FROM outbox WHERE doc_id = ?').run(docId);
      db.prepare('DELETE FROM doc_shadow WHERE doc_id = ?').run(docId);
      return Number(result.changes);
    },
    hasUnsettled(docId) {
      return (
        db
          .prepare(
            `SELECT 1 AS present FROM outbox WHERE doc_id = ? LIMIT 1`,
          )
          .get(docId) !== undefined
      );
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * Read the durable queue counts for one server without keeping the cache open.
 * The settings surface uses this to show pending edits even while the plugin is
 * in local mode (they belong to the configured server, not the local data).
 */
export function readRemoteQueueCounts(
  directory: string,
  scope: string,
): QueueCounts {
  let cache: RemoteCache | undefined;
  try {
    cache = openRemoteCache(directory, scope);
    return cache.counts();
  } catch {
    return { pending: 0, conflicts: 0, failed: 0 };
  } finally {
    cache?.close();
  }
}

/** Remove the cache/queue file for one server (after an authority migration). */
export async function removeRemoteCache(
  directory: string,
  scope: string,
): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(join(directory, cacheFileName(scope)), { force: true }).catch(
    () => undefined,
  );
  // WAL/SHM siblings left behind by a crashed process would resurrect rows.
  await rm(`${join(directory, cacheFileName(scope))}-wal`, {
    force: true,
  }).catch(() => undefined);
  await rm(`${join(directory, cacheFileName(scope))}-shm`, {
    force: true,
  }).catch(() => undefined);
}

/** Create a fresh idempotency key for queued writes that had none. */
export function newOutboxIdempotencyKey(): string {
  return `idem-${randomUUID()}`;
}
