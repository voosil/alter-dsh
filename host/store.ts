/**
 * SQLite-backed persistent authority for Space product data.
 *
 * The Space business service (under `vendor/service`) reads
 * one `SpaceStoreData` value synchronously and mutates it inside
 * `store.update(change)`. This store keeps that exact shape in memory and
 * persists each entity as one JSON row, so a small edit writes only the rows
 * that changed instead of re-serializing the whole database.
 *
 * Layout:
 * - one `STRICT` table per collection, `(id TEXT PRIMARY KEY, data TEXT)`;
 * - `hub(space_id TEXT PRIMARY KEY, data TEXT)`;
 * - `meta(key, value)` for array order and bookkeeping;
 * - `PRAGMA user_version` for the schema version.
 *
 * Writes run on one serial queue and use one SQLite transaction each. Reads
 * come from the in-memory value; `update` resolves only after COMMIT, so an
 * awaited write is durable. A failed write rolls the in-memory value back to
 * its pre-change snapshot.
 */
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  SpaceStore,
  SpaceStoreData,
} from '../vendor/service/src/contracts.js';

export type { SpaceStoreData } from '../vendor/service/src/contracts.js';
import type {
  DocumentAssetRecord,
  DocumentObjectRecord,
  DocumentOpRecord,
  DocumentSidecar,
} from './document/types.js';
import {
  STORAGE_SETTINGS_KEY,
  WAL_SIZE_LIMIT,
  clampStorageSettings,
  parseStorageSettings,
  type StorageSettings,
} from './settings.js';

/** Business data file inside the configured data directory. */
export const SPACE_DB_FILE = 'space.db';
/** Default space id. */
export const DEFAULT_SPACE_ID = 'sp-inbox';
/** Default space name. */
export const DEFAULT_SPACE_NAME = '日常';

const FORMAT_VERSION = 3;
const ORDER_PREFIX = 'order:';
/** Sidecar table owning the Space ↔ DSH workspace binding (schema v2). */
const WORKSPACE_LINKS_TABLE = 'workspace_links';
const CREATE_WORKSPACE_LINKS = `CREATE TABLE IF NOT EXISTS ${WORKSPACE_LINKS_TABLE} (space_id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;`;
/** Document-model sidecar tables (schema v3). */
const DOCUMENT_OBJECTS_TABLE = 'document_objects';
const DOCUMENT_ASSETS_TABLE = 'document_assets';
const DOCUMENT_OPS_TABLE = 'document_ops';
const CREATE_DOCUMENT_OBJECTS = `CREATE TABLE IF NOT EXISTS ${DOCUMENT_OBJECTS_TABLE} (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, data TEXT NOT NULL) STRICT;`;
const CREATE_DOCUMENT_ASSETS = `CREATE TABLE IF NOT EXISTS ${DOCUMENT_ASSETS_TABLE} (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;`;
const CREATE_DOCUMENT_OPS = `CREATE TABLE IF NOT EXISTS ${DOCUMENT_OPS_TABLE} (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, sequence INTEGER NOT NULL, idempotency_key TEXT, data TEXT NOT NULL) STRICT;`;
const CREATE_DOCUMENT_OPS_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS ${DOCUMENT_OPS_TABLE}_idempotency ON ${DOCUMENT_OPS_TABLE} (doc_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`;
const DOCUMENT_SCHEMA = [
  CREATE_DOCUMENT_OBJECTS,
  CREATE_DOCUMENT_ASSETS,
  CREATE_DOCUMENT_OPS,
  CREATE_DOCUMENT_OPS_INDEX,
].join('\n');
/** Corruption copies kept on disk at most. */
const MAX_CORRUPT_BACKUPS = 2;
/** Total bytes corruption copies may occupy at most. */
const MAX_CORRUPT_BACKUP_BYTES = 256 * 1024 * 1024;
const CORRUPT_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
/** SQLite primary result codes that really mean "not a usable database". */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
/** Makes corruption copies unique even when the clock repeats a millisecond. */
let corruptSequence = 0;

const COLLECTIONS = [
  'spaces',
  'nodes',
  'thoughts',
  'comments',
  'versions',
  'agents',
  'tasks',
  'events',
  'milestones',
] as const;

type Collection = (typeof COLLECTIONS)[number];
type Entity = { id: string };

/** Minimal logger contract; the Host passes `ctx.logger`. */
export interface SpaceStoreLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface OpenSpaceStoreOptions {
  /** Directory that owns the database file. */
  directory: string;
  /** Business clock; tests inject a fixed clock. */
  now?: () => Date;
  /** Host logger; diagnostics are best-effort. */
  logger?: SpaceStoreLogger;
}

/**
 * One persisted Space ↔ DSH workspace binding.
 *
 * The binding is plugin-owned sidecar data, never part of the Space entity:
 * the workspace is a Host-level DSH concept, while the Space database keeps
 * its own format.
 */
export interface SpaceWorkspaceLink {
  /** Owning Space id. */
  spaceId: string;
  /** DSH workspace id created or adopted for the Space's primary directory. */
  workspaceId: string;
  /** Canonical absolute primary directory the workspace owns. */
  path: string;
  /** Workspace title last applied by this plugin (marker included). */
  appliedTitle: string;
  /** ISO-8601 instant of the last applied binding. */
  updatedAt: string;
}

/** Persisted authority, plus the operations the Host lifecycle needs. */
export interface SpaceStoreHandle extends SpaceStore {
  /** Absolute database file path. */
  readonly file: string;
  /** Current storage policy, loaded from the SQLite `meta` table. */
  getStorageSettings(): StorageSettings;
  /** Persist a storage policy; resolves after COMMIT. */
  setStorageSettings(settings: StorageSettings): Promise<void>;
  /** Read one Space ↔ workspace binding. */
  getWorkspaceLink(spaceId: string): SpaceWorkspaceLink | undefined;
  /** Read every Space ↔ workspace binding in Space insertion order. */
  listWorkspaceLinks(): SpaceWorkspaceLink[];
  /** Persist one binding; resolves after COMMIT. */
  setWorkspaceLink(link: SpaceWorkspaceLink): Promise<void>;
  /** Drop one binding; resolves after COMMIT. */
  deleteWorkspaceLink(spaceId: string): Promise<void>;
  /** Read one structured/application object sidecar row. */
  getDocumentObject(id: string): DocumentObjectRecord | undefined;
  /** Read every object row owned by one document. */
  listDocumentObjects(docId: string): DocumentObjectRecord[];
  /** Read one asset sidecar row. */
  getDocumentAsset(id: string): DocumentAssetRecord | undefined;
  /** Read the operation log of one document, oldest first. */
  listDocumentOps(docId: string, limit?: number): DocumentOpRecord[];
  /** Read one operation-log row by id. */
  getDocumentOp(id: string): DocumentOpRecord | undefined;
  /** Find one operation-log row by idempotency key. */
  findDocumentOpByKey(
    docId: string,
    idempotencyKey: string,
  ): DocumentOpRecord | undefined;
  /**
   * Run one document write atomically: block-collection changes and document
   * sidecar writes commit in the same transaction, or both roll back.
   */
  transactDocument<T>(
    change: (value: SpaceStoreData, sidecar: DocumentSidecar) => T,
  ): Promise<T>;
  /** Write a consistent, compacted copy of the database to `destination`. */
  snapshotInto(destination: string): Promise<void>;
  /** Drain queued writes and close the connection. */
  close(): Promise<void>;
}

const CREATE_TABLE = (name: string, key: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (${key} TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;`;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;',
  ...COLLECTIONS.map((name) => CREATE_TABLE(name, 'id')),
  CREATE_TABLE('hub', 'space_id'),
  CREATE_WORKSPACE_LINKS,
  DOCUMENT_SCHEMA,
].join('\n');

function defaultSpace(now: Date) {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    goal: '',
    directories: [] as string[],
    collaboratorIds: [] as string[],
    isDefault: true,
    order: 0,
    createdAt: now.toISOString(),
    archivedAt: null,
  };
}

/** Full default data used for a brand-new database. */
export function createDefaultData(now: Date): SpaceStoreData {
  return {
    version: 1,
    spaces: [defaultSpace(now)],
    nodes: [],
    thoughts: [],
    comments: [],
    versions: [],
    agents: [],
    tasks: [],
    events: [],
    milestones: [],
    hub: {},
  };
}

function emptyCollections(): Pick<SpaceStoreData, Collection> {
  return {
    spaces: [],
    nodes: [],
    thoughts: [],
    comments: [],
    versions: [],
    agents: [],
    tasks: [],
    events: [],
    milestones: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** SQLite primary result code carried by `node:sqlite` errors, if any. */
function sqliteErrcode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' ? errcode & 0xff : undefined;
}

/** Whether a failure means the file content is corrupt, not merely locked. */
function isCorruptionError(error: unknown): boolean {
  const code = sqliteErrcode(error);
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB;
}

function corruptStamp(now: () => Date): string {
  corruptSequence += 1;
  return `${now().toISOString().replaceAll(':', '-')}-${process.pid}-${corruptSequence}`;
}

/** StatementSync.close() exists at runtime but is missing from @types/node 26. */
function closeStatement(statement: unknown): void {
  const candidate = statement as { close?: () => void };
  if (typeof candidate.close === 'function') candidate.close();
}

function openDatabase(file: string): DatabaseSync {
  return new DatabaseSync(file);
}

function configureDatabase(db: DatabaseSync): void {
  // The busy timeout comes first: switching the journal mode may need a lock,
  // and a momentary lock must not be mistaken for corruption later.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  // Cap how much of the WAL file survives a checkpoint (unclean shutdown).
  db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | Record<string, unknown>
    | undefined;
  return Number(row?.user_version ?? 0);
}

function quickCheck(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA quick_check').get() as
    | Record<string, unknown>
    | undefined;
  return row?.quick_check === 'ok';
}

async function setFileMode(file: string): Promise<void> {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      await chmod(candidate, 0o600);
    } catch {
      // The WAL/SHM files may not exist yet; permissions are best-effort.
    }
  }
}

/**
 * Move an unreadable database (and its sidecars) aside so a fresh one can
 * start. Sidecars go first and the main database last, so a crash halfway
 * leaves a recoverable original path instead of an orphaned WAL.
 * @returns absolute path of the backup copy.
 */
async function backupCorruptDatabase(
  file: string,
  now: () => Date,
  logger: SpaceStoreLogger,
): Promise<string> {
  const target = `${file}.corrupt-${corruptStamp(now)}`;
  for (const suffix of CORRUPT_SUFFIXES) {
    try {
      await rename(`${file}${suffix}`, `${target}${suffix}`);
    } catch {
      // Missing sidecars are expected; only the main database is mandatory.
    }
  }
  try {
    await rename(file, target);
  } catch (error) {
    logger.warn?.(
      `[alter-dsh-space] Space 数据库损坏，但无法备份原文件：${describeError(error)}`,
    );
    throw new Error(
      `Space 数据库无法读取且无法备份（${describeError(error)}），已保留原文件`,
    );
  }
  logger.warn?.(
    `[alter-dsh-space] Space 数据库损坏，已备份到 ${target} 并重建默认数据`,
  );
  return target;
}

/**
 * Bound the corruption backups: keep the newest group(s) within a byte cap so
 * a recurring failure cannot fill the disk. Never deletes the newest group.
 */
async function pruneCorruptBackups(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const prefix = `${SPACE_DB_FILE}.corrupt-`;
  const groups = new Map<string, string[]>();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const stamp = name.slice(prefix.length).replace(/-(?:wal|shm|journal)$/u, '');
    const files = groups.get(stamp) ?? [];
    files.push(name);
    groups.set(stamp, files);
  }
  const ordered = [...groups.entries()].sort(([left], [right]) =>
    right.localeCompare(left),
  );
  let keptGroups = 0;
  let keptBytes = 0;
  for (const [, files] of ordered) {
    let bytes = 0;
    for (const name of files) {
      try {
        bytes += (await stat(join(directory, name))).size;
      } catch {
        // A vanished file contributes nothing.
      }
    }
    const keep =
      keptGroups === 0 ||
      (keptGroups < MAX_CORRUPT_BACKUPS &&
        keptBytes + bytes <= MAX_CORRUPT_BACKUP_BYTES);
    if (keep) {
      keptGroups += 1;
      keptBytes += bytes;
      continue;
    }
    for (const name of files) {
      try {
        await rm(join(directory, name), { force: true });
      } catch {
        // Pruning is best-effort; startup must not fail on it.
      }
    }
  }
}

/** Read the persisted storage policy JSON from `meta`. */
function readStorageSettingsValue(db: DatabaseSync): string | undefined {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(STORAGE_SETTINGS_KEY) as { value?: string } | undefined;
  return typeof row?.value === 'string' ? row.value : undefined;
}

function readOrder(db: DatabaseSync, collection: Collection): string[] {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(`${ORDER_PREFIX}${collection}`) as { value?: string } | undefined;
  if (typeof row?.value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** Rebuild the in-memory value from the SQLite rows. */
function readDatabase(db: DatabaseSync, now: () => Date): SpaceStoreData {
  const data: SpaceStoreData = {
    version: 1,
    ...emptyCollections(),
    hub: {},
  };
  const rowsPerCollection = new Map<Collection, Map<string, string>>();
  for (const collection of COLLECTIONS) {
    const rows = db
      .prepare(`SELECT id, data FROM ${collection}`)
      .all() as Array<{ id: string; data: string }>;
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.id, row.data);
    rowsPerCollection.set(collection, map);
  }
  for (const collection of COLLECTIONS) {
    const rows = rowsPerCollection.get(collection)!;
    const order = readOrder(db, collection);
    const seen = new Set<string>();
    const items: Entity[] = [];
    for (const id of order) {
      const raw = rows.get(id);
      if (raw === undefined || seen.has(id)) continue;
      seen.add(id);
      items.push(parseEntityRow(collection, id, raw));
    }
    for (const [id, raw] of rows) {
      if (seen.has(id)) continue;
      items.push(parseEntityRow(collection, id, raw));
    }
    data[collection] = items as never;
  }
  const hubRows = db
    .prepare('SELECT space_id, data FROM hub')
    .all() as Array<{ space_id: string; data: string }>;
  for (const row of hubRows) {
    const raw = parseJsonObject(row.data);
    if (raw !== undefined) data.hub[row.space_id] = raw as never;
  }
  if (data.spaces.length === 0) data.spaces = [defaultSpace(now())];
  return data;
}

/** Rebuild the Space ↔ workspace bindings from their sidecar rows. */
function readWorkspaceLinks(db: DatabaseSync): SpaceWorkspaceLink[] {
  const rows = db
    .prepare(`SELECT space_id, data FROM ${WORKSPACE_LINKS_TABLE}`)
    .all() as Array<{ space_id: string; data: string }>;
  const links: SpaceWorkspaceLink[] = [];
  for (const row of rows) {
    const parsed = parseJsonObject(row.data);
    if (parsed === undefined) continue;
    const { spaceId, workspaceId, path, appliedTitle, updatedAt } = parsed;
    // A row that lost its shape is unusable, but must never break the whole
    // database: the Space keeps working without its workspace binding.
    if (
      typeof spaceId !== 'string' ||
      typeof workspaceId !== 'string' ||
      typeof path !== 'string' ||
      typeof appliedTitle !== 'string' ||
      typeof updatedAt !== 'string'
    )
      continue;
    links.push({ spaceId, workspaceId, path, appliedTitle, updatedAt });
  }
  return links;
}

type DocumentSidecarWrite =
  | { kind: 'object'; record: DocumentObjectRecord }
  | { kind: 'asset'; record: DocumentAssetRecord }
  | { kind: 'op'; record: DocumentOpRecord };

function readDocumentObject(
  db: DatabaseSync,
  id: string,
): DocumentObjectRecord | undefined {
  const row = db
    .prepare(`SELECT data FROM ${DOCUMENT_OBJECTS_TABLE} WHERE id = ?`)
    .get(id) as { data: string } | undefined;
  const parsed = row === undefined ? undefined : parseJsonObject(row.data);
  if (
    parsed === undefined ||
    typeof parsed.id !== 'string' ||
    typeof parsed.docId !== 'string' ||
    (parsed.type !== 'mindmap' && parsed.type !== 'component') ||
    typeof parsed.schemaVersion !== 'number' ||
    parsed.payload === undefined ||
    typeof parsed.createdAt !== 'string'
  )
    return undefined;
  return parsed as unknown as DocumentObjectRecord;
}

function readDocumentObjects(
  db: DatabaseSync,
  docId: string,
): DocumentObjectRecord[] {
  const rows = db
    .prepare(
      `SELECT id FROM ${DOCUMENT_OBJECTS_TABLE} WHERE doc_id = ? ORDER BY rowid ASC`,
    )
    .all(docId) as Array<{ id: string }>;
  const records: DocumentObjectRecord[] = [];
  for (const row of rows) {
    const record = readDocumentObject(db, row.id);
    if (record !== undefined) records.push(record);
  }
  return records;
}

function readDocumentAsset(
  db: DatabaseSync,
  id: string,
): DocumentAssetRecord | undefined {
  const row = db
    .prepare(`SELECT data FROM ${DOCUMENT_ASSETS_TABLE} WHERE id = ?`)
    .get(id) as { data: string } | undefined;
  const parsed = row === undefined ? undefined : parseJsonObject(row.data);
  if (
    parsed === undefined ||
    typeof parsed.id !== 'string' ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.mime !== 'string' ||
    typeof parsed.bytes !== 'number' ||
    typeof parsed.createdAt !== 'string'
  )
    return undefined;
  return parsed as unknown as DocumentAssetRecord;
}

function readDocumentOp(
  db: DatabaseSync,
  id: string,
): DocumentOpRecord | undefined {
  const row = db
    .prepare(`SELECT data FROM ${DOCUMENT_OPS_TABLE} WHERE id = ?`)
    .get(id) as { data: string } | undefined;
  const parsed = row === undefined ? undefined : parseJsonObject(row.data);
  if (
    parsed === undefined ||
    typeof parsed.id !== 'string' ||
    typeof parsed.docId !== 'string' ||
    typeof parsed.revision !== 'number' ||
    typeof parsed.actor !== 'string' ||
    !Array.isArray(parsed.ops) ||
    !Array.isArray(parsed.inverseOps) ||
    typeof parsed.createdAt !== 'string'
  )
    return undefined;
  return parsed as unknown as DocumentOpRecord;
}

function readDocumentOps(
  db: DatabaseSync,
  docId: string,
  limit?: number,
): DocumentOpRecord[] {
  const rows = db
    .prepare(
      `SELECT id FROM ${DOCUMENT_OPS_TABLE} WHERE doc_id = ? ORDER BY sequence ASC, rowid ASC LIMIT ?`,
    )
    .all(docId, limit ?? -1) as Array<{ id: string }>;
  const records: DocumentOpRecord[] = [];
  for (const row of rows) {
    const record = readDocumentOp(db, row.id);
    if (record !== undefined) records.push(record);
  }
  return records;
}

function readDocumentOpByKey(
  db: DatabaseSync,
  docId: string,
  idempotencyKey: string,
): DocumentOpRecord | undefined {
  const row = db
    .prepare(
      `SELECT id FROM ${DOCUMENT_OPS_TABLE} WHERE doc_id = ? AND idempotency_key = ?`,
    )
    .get(docId, idempotencyKey) as { id: string } | undefined;
  return row === undefined ? undefined : readDocumentOp(db, row.id);
}

function flushDocumentWrites(
  db: DatabaseSync,
  writes: readonly DocumentSidecarWrite[],
): void {
  const putObject = db.prepare(
    `INSERT INTO ${DOCUMENT_OBJECTS_TABLE} (id, doc_id, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET doc_id = excluded.doc_id, data = excluded.data`,
  );
  const putAsset = db.prepare(
    `INSERT INTO ${DOCUMENT_ASSETS_TABLE} (id, data) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
  );
  const appendOp = db.prepare(
    `INSERT INTO ${DOCUMENT_OPS_TABLE} (id, doc_id, sequence, idempotency_key, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       doc_id = excluded.doc_id,
       sequence = excluded.sequence,
       idempotency_key = excluded.idempotency_key,
       data = excluded.data`,
  );
  try {
    for (const write of writes) {
      if (write.kind === 'object')
        putObject.run(
          write.record.id,
          write.record.docId,
          JSON.stringify(write.record),
        );
      else if (write.kind === 'asset')
        putAsset.run(write.record.id, JSON.stringify(write.record));
      else
        appendOp.run(
          write.record.id,
          write.record.docId,
          write.record.revision,
          write.record.idempotencyKey ?? null,
          JSON.stringify(write.record),
        );
    }
  } finally {
    closeStatement(putObject);
    closeStatement(putAsset);
    closeStatement(appendOp);
  }
}

function parseEntityRow(
  _collection: Collection,
  id: string,
  raw: string,
): Entity {
  const parsed = parseJsonObject(raw);
  if (parsed !== undefined && parsed.id === undefined) parsed.id = id;
  return (parsed ?? { id }) as Entity;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Serialized snapshot used for per-entity diffing. */
interface PersistedSnapshot {
  entities: Map<Collection, Map<string, string>>;
  hub: Map<string, string>;
}

function snapshotPersisted(data: SpaceStoreData): PersistedSnapshot {
  const entities = new Map<Collection, Map<string, string>>();
  for (const collection of COLLECTIONS) {
    const map = new Map<string, string>();
    for (const entity of data[collection]) map.set(entity.id, JSON.stringify(entity));
    entities.set(collection, map);
  }
  const hub = new Map<string, string>();
  for (const [spaceId, snapshot] of Object.entries(data.hub))
    hub.set(spaceId, JSON.stringify(snapshot));
  return { entities, hub };
}

interface WritePlanRow {
  collection: Collection;
  upserts: Array<[id: string, json: string]>;
  deletes: string[];
  order?: string[];
}

interface WritePlan {
  rows: WritePlanRow[];
  hubUpserts: Array<[spaceId: string, json: string]>;
  hubDeletes: string[];
}

/** Compute the changed rows between the live value and the persisted snapshot. */
function planWrite(
  data: SpaceStoreData,
  persisted: PersistedSnapshot,
  previousSpacesIds: Map<Collection, string[]>,
): WritePlan {
  const rows: WritePlanRow[] = [];
  for (const collection of COLLECTIONS) {
    const before = persisted.entities.get(collection)!;
    const next = new Map<string, string>();
    const ids: string[] = [];
    const upserts: Array<[string, string]> = [];
    for (const entity of data[collection]) {
      const id = String(entity.id);
      ids.push(id);
      const json = JSON.stringify(entity);
      next.set(id, json);
      if (before.get(id) !== json) upserts.push([id, json]);
    }
    const deletes: string[] = [];
    for (const id of before.keys()) if (!next.has(id)) deletes.push(id);
    const previousIds = previousSpacesIds.get(collection) ?? [];
    const orderChanged =
      previousIds.length !== ids.length ||
      previousIds.some((id, index) => id !== ids[index]);
    if (upserts.length === 0 && deletes.length === 0 && !orderChanged) continue;
    rows.push({
      collection,
      upserts,
      deletes,
      ...(orderChanged ? { order: ids } : {}),
    });
  }
  const hubUpserts: Array<[string, string]> = [];
  const nextHub = new Map<string, string>();
  for (const [spaceId, snapshot] of Object.entries(data.hub)) {
    const json = JSON.stringify(snapshot);
    nextHub.set(spaceId, json);
    if (persisted.hub.get(spaceId) !== json) hubUpserts.push([spaceId, json]);
  }
  const hubDeletes: string[] = [];
  for (const spaceId of persisted.hub.keys())
    if (!nextHub.has(spaceId)) hubDeletes.push(spaceId);
  return { rows, hubUpserts, hubDeletes };
}

function applyWritePlan(
  db: DatabaseSync,
  plan: WritePlan,
  persisted: PersistedSnapshot,
  data: SpaceStoreData,
  beforeCommit?: () => void,
): void {
  const orders = new Map<Collection, string[]>();
  for (const collection of COLLECTIONS) {
    const ids = data[collection].map((entity) => String(entity.id));
    orders.set(collection, ids);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of plan.rows) {
      const upsert = db.prepare(
        `INSERT INTO ${row.collection} (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      );
      try {
        for (const [id, json] of row.upserts) upsert.run(id, json);
        for (const id of row.deletes)
          db.prepare(`DELETE FROM ${row.collection} WHERE id = ?`).run(id);
      } finally {
        closeStatement(upsert);
      }
      if (row.order) setMeta(db, `${ORDER_PREFIX}${row.collection}`, JSON.stringify(row.order));
    }
    const hubUpsert = db.prepare(
      `INSERT INTO hub (space_id, data) VALUES (?, ?)
       ON CONFLICT(space_id) DO UPDATE SET data = excluded.data`,
    );
    try {
      for (const [spaceId, json] of plan.hubUpserts)
        hubUpsert.run(spaceId, json);
      for (const spaceId of plan.hubDeletes)
        db.prepare('DELETE FROM hub WHERE space_id = ?').run(spaceId);
    } finally {
      closeStatement(hubUpsert);
    }
    beforeCommit?.();
    setMeta(db, 'updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed transaction may already have been rolled back by SQLite.
    }
    throw error;
  }
  // Commit succeeded: the persisted snapshot now matches the live value.
  for (const collection of COLLECTIONS) {
    const map = persisted.entities.get(collection)!;
    map.clear();
    for (const entity of data[collection])
      map.set(String(entity.id), JSON.stringify(entity));
  }
  persisted.hub.clear();
  for (const [spaceId, snapshot] of Object.entries(data.hub))
    persisted.hub.set(spaceId, JSON.stringify(snapshot));
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Replace every row in one transaction; used when creating a new database. */
function persistAll(db: DatabaseSync, data: SpaceStoreData): void {
  const upsertMeta = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const collection of COLLECTIONS) {
      db.exec(`DELETE FROM ${collection}`);
      const insert = db.prepare(`INSERT INTO ${collection} (id, data) VALUES (?, ?)`);
      try {
        for (const entity of data[collection])
          insert.run(String(entity.id), JSON.stringify(entity));
      } finally {
        closeStatement(insert);
      }
      upsertMeta.run(
        `${ORDER_PREFIX}${collection}`,
        JSON.stringify(data[collection].map((entity) => String(entity.id))),
      );
    }
    db.exec('DELETE FROM hub');
    db.exec(`DELETE FROM ${WORKSPACE_LINKS_TABLE}`);
    const hubInsert = db.prepare('INSERT INTO hub (space_id, data) VALUES (?, ?)');
    try {
      for (const [spaceId, snapshot] of Object.entries(data.hub))
        hubInsert.run(spaceId, JSON.stringify(snapshot));
    } finally {
      closeStatement(hubInsert);
    }
    upsertMeta.run('updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure; the caller retries from a fresh open.
    }
    throw error;
  } finally {
    closeStatement(upsertMeta);
  }
}

function isDatabaseEmpty(db: DatabaseSync): boolean {
  for (const collection of COLLECTIONS) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${collection}`).get() as
      | { count?: number }
      | undefined;
    if (Number(row?.count ?? 0) > 0) return false;
  }
  const hub = db.prepare('SELECT COUNT(*) AS count FROM hub').get() as
    | { count?: number }
    | undefined;
  return Number(hub?.count ?? 0) === 0;
}

/**
 * Open (or create) the Space authority in `directory`.
 *
 * All writes are serialized and committed before they resolve; a failing write
 * restores the pre-change in-memory value. The database file is created 0600
 * inside a 0700 directory.
 */
export async function openSpaceStore(
  options: OpenSpaceStoreOptions,
): Promise<SpaceStoreHandle> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? {};
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const file = join(options.directory, SPACE_DB_FILE);

  let db: DatabaseSync;
  let recovered = false;
  let candidate: DatabaseSync | undefined;
  try {
    candidate = openDatabase(file);
    configureDatabase(candidate);
    if (!quickCheck(candidate)) recovered = true;
  } catch (error) {
    // Only "not a database" failures mean corruption. A lock, permission or
    // I/O problem must keep the file untouched and surface its real cause
    // instead of moving a healthy database aside.
    if (!isCorruptionError(error)) {
      try {
        candidate?.close();
      } catch {
        // Ignore close failure while reporting the original error.
      }
      throw error;
    }
    recovered = true;
  }
  if (recovered) {
    try {
      candidate?.close();
    } catch {
      // Ignore close failure after a corrupt read.
    }
    await backupCorruptDatabase(file, now, logger);
    db = openDatabase(file);
    configureDatabase(db);
    // Retention: repeated corruption must not accumulate full copies forever.
    await pruneCorruptBackups(options.directory).catch(() => undefined);
  } else {
    db = candidate!;
  }
  // Drop WAL residue left behind by an unclean shutdown; later growth is
  // bounded by `journal_size_limit`.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // A busy database keeps its WAL; the limit still applies at checkpoint.
  }
  await setFileMode(file);

  let version = readUserVersion(db);
  if (version > FORMAT_VERSION) {
    db.close();
    throw new Error(
      `Space 数据库结构版本 ${version} 高于当前插件支持的版本 ${FORMAT_VERSION}，请升级插件`,
    );
  }
  if (version === 0) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
    version = FORMAT_VERSION;
  } else if (version < FORMAT_VERSION) {
    // v1 → v2: Space ↔ workspace sidecar; v2 → v3: document-model sidecars.
    // Business tables are untouched, so every step is an idempotent CREATE.
    db.exec(CREATE_WORKSPACE_LINKS);
    db.exec(DOCUMENT_SCHEMA);
    db.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
    version = FORMAT_VERSION;
  }
  // Defensive: sidecar tables missing from a current-version database are
  // healed here instead of failing every later write.
  db.exec(CREATE_WORKSPACE_LINKS);
  db.exec(DOCUMENT_SCHEMA);

  const storageSettings = parseStorageSettings(readStorageSettingsValue(db));

  const fresh = isDatabaseEmpty(db);
  let data: SpaceStoreData;
  if (fresh) {
    data = createDefaultData(now());
    persistAll(db, data);
    await setFileMode(file);
  } else {
    data = readDatabase(db, now);
  }

  const workspaceLinks = new Map<string, SpaceWorkspaceLink>();
  for (const link of readWorkspaceLinks(db)) workspaceLinks.set(link.spaceId, link);

  const persisted = snapshotPersisted(data);
  const orderSnapshot = new Map<Collection, string[]>();
  for (const collection of COLLECTIONS)
    orderSnapshot.set(
      collection,
      data[collection].map((entity) => String(entity.id)),
    );

  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let currentSettings = storageSettings;

  function enqueue<T>(job: () => T | Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('Space 数据已关闭'));
    const run = queue.then(job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function update<T>(change: (value: SpaceStoreData) => T): Promise<T> {
    return enqueue(async () => {
      const snapshot = structuredClone(data);
      let result: T;
      try {
        result = change(data);
      } catch (error) {
        data = snapshot;
        throw error;
      }
      let plan: WritePlan;
      try {
        plan = planWrite(data, persisted, orderSnapshot);
      } catch (error) {
        data = snapshot;
        throw error;
      }
      const changed =
        plan.rows.length > 0 ||
        plan.hubUpserts.length > 0 ||
        plan.hubDeletes.length > 0;
      if (changed) {
        try {
          applyWritePlan(db, plan, persisted, data);
          for (const collection of COLLECTIONS)
            orderSnapshot.set(
              collection,
              data[collection].map((entity) => String(entity.id)),
            );
        } catch (error) {
          data = snapshot;
          throw error;
        }
      }
      return result;
    });
  }

  function transactDocument<T>(
    change: (value: SpaceStoreData, sidecar: DocumentSidecar) => T,
  ): Promise<T> {
    return enqueue(async () => {
      const snapshot = structuredClone(data);
      const writes: DocumentSidecarWrite[] = [];
      const sidecar: DocumentSidecar = {
        getObject: (id) => readDocumentObject(db, id),
        listObjects: (docId) => readDocumentObjects(db, docId),
        putObject(record) {
          writes.push({ kind: 'object', record });
        },
        getAsset: (id) => readDocumentAsset(db, id),
        putAsset(record) {
          writes.push({ kind: 'asset', record });
        },
        listOps: (docId, limit) => readDocumentOps(db, docId, limit),
        findOpByKey: (docId, key) => readDocumentOpByKey(db, docId, key),
        appendOp(record) {
          writes.push({ kind: 'op', record });
        },
      };
      let result: T;
      try {
        result = change(data, sidecar);
      } catch (error) {
        data = snapshot;
        throw error;
      }
      let plan: WritePlan;
      try {
        plan = planWrite(data, persisted, orderSnapshot);
      } catch (error) {
        data = snapshot;
        throw error;
      }
      try {
        applyWritePlan(db, plan, persisted, data, () =>
          flushDocumentWrites(db, writes),
        );
        for (const collection of COLLECTIONS)
          orderSnapshot.set(
            collection,
            data[collection].map((entity) => String(entity.id)),
          );
      } catch (error) {
        data = snapshot;
        throw error;
      }
      return result;
    });
  }

  function writeWorkspaceLink(link: SpaceWorkspaceLink): Promise<void> {
    return enqueue(() => {
      db.exec('BEGIN IMMEDIATE');
      const statement = db.prepare(
        `INSERT INTO ${WORKSPACE_LINKS_TABLE} (space_id, data) VALUES (?, ?)
         ON CONFLICT(space_id) DO UPDATE SET data = excluded.data`,
      );
      try {
        statement.run(link.spaceId, JSON.stringify(link));
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // A failed transaction may already have been rolled back by SQLite.
        }
        throw error;
      } finally {
        closeStatement(statement);
      }
      workspaceLinks.set(link.spaceId, { ...link });
    });
  }

  function removeWorkspaceLink(spaceId: string): Promise<void> {
    return enqueue(() => {
      db.exec('BEGIN IMMEDIATE');
      const statement = db.prepare(
        `DELETE FROM ${WORKSPACE_LINKS_TABLE} WHERE space_id = ?`,
      );
      try {
        statement.run(spaceId);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // A failed transaction may already have been rolled back by SQLite.
        }
        throw error;
      } finally {
        closeStatement(statement);
      }
      workspaceLinks.delete(spaceId);
    });
  }

  return {
    file,
    read: () => data,
    update,
    getStorageSettings: () => ({ ...currentSettings }),
    setStorageSettings(next) {
      const value = clampStorageSettings(next);
      return enqueue(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
          setMeta(db, STORAGE_SETTINGS_KEY, JSON.stringify(value));
          db.exec('COMMIT');
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // A failed transaction may already be rolled back by SQLite.
          }
          throw error;
        }
        currentSettings = value;
      });
    },
    getWorkspaceLink(spaceId) {
      const link = workspaceLinks.get(spaceId);
      return link === undefined ? undefined : { ...link };
    },
    listWorkspaceLinks: () => [...workspaceLinks.values()].map((link) => ({ ...link })),
    setWorkspaceLink: writeWorkspaceLink,
    deleteWorkspaceLink: removeWorkspaceLink,
    getDocumentObject: (id) => readDocumentObject(db, id),
    listDocumentObjects: (docId) => readDocumentObjects(db, docId),
    getDocumentAsset: (id) => readDocumentAsset(db, id),
    listDocumentOps: (docId, limit) => readDocumentOps(db, docId, limit),
    getDocumentOp: (id) => readDocumentOp(db, id),
    findDocumentOpByKey: (docId, key) => readDocumentOpByKey(db, docId, key),
    transactDocument,
    snapshotInto(destination) {
      return enqueue(() => {
        const target = destination.replaceAll("'", "''");
        db.exec(`VACUUM INTO '${target}'`);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Checkpoint is best-effort; closing still releases the handle.
      }
      db.close();
    },
  };
}
