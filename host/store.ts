/**
 * SQLite-backed persistent authority for Space product data.
 *
 * The upstream Space business service (vendored under `vendor/service`) reads
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
import { chmod, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HubSnapshot } from '@alter/protocol';
import type {
  SpaceStore,
  SpaceStoreData,
} from '../vendor/service/src/contracts.js';

/** Business data file inside the configured data directory. */
export const SPACE_DB_FILE = 'space.db';
/** Default space id; identical to the upstream store and the mock seed. */
export const DEFAULT_SPACE_ID = 'sp-inbox';
/** Default space name. */
export const DEFAULT_SPACE_NAME = '日常';

const FORMAT_VERSION = 1;
const LEGACY_JSON_FILE = 'space.json';
const ORDER_PREFIX = 'order:';
const MAX_IMPORT_ENTITIES = 500_000;

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

export type ImportResult =
  | { imported: true; counts: Record<string, number> }
  | { imported: false; reason: 'host-not-empty' };

/** Persisted authority, plus the operations the RPC/import layer needs. */
export interface SpaceStoreHandle extends SpaceStore {
  /** Absolute database file path. */
  readonly file: string;
  /** Whether the database still holds only the untouched default state. */
  isEmpty(): boolean;
  /** Replace the whole database in one transaction (only when {@link isEmpty}). */
  importData(database: SpaceStoreData): Promise<ImportResult>;
  /** Drain queued writes and close the connection. */
  close(): Promise<void>;
}

const CREATE_TABLE = (name: string, key: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (${key} TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;`;

const SCHEMA = [
  CREATE_TABLE('meta', 'key'),
  ...COLLECTIONS.map((name) => CREATE_TABLE(name, 'id')),
  CREATE_TABLE('hub', 'space_id'),
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

/** Same accepted data shape as the upstream JSON store parser. */
function parseSpaceStoreData(value: unknown): SpaceStoreData | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  for (const field of COLLECTIONS) {
    if (!Array.isArray(record[field])) record[field] = [];
  }
  const hub = record.hub;
  if (typeof hub !== 'object' || hub === null || Array.isArray(hub))
    record.hub = {};
  return record as unknown as SpaceStoreData;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `data` is still the untouched first-run state. */
export function isPristineSpaceData(data: SpaceStoreData): boolean {
  if (data.spaces.length !== 1) return false;
  const space = data.spaces[0];
  if (space.id !== DEFAULT_SPACE_ID) return false;
  if (space.name !== DEFAULT_SPACE_NAME) return false;
  if (space.goal !== '') return false;
  if (space.directories.length !== 0) return false;
  if (space.collaboratorIds.length !== 0) return false;
  if (space.isDefault !== true) return false;
  if (space.archivedAt !== null) return false;
  for (const collection of COLLECTIONS) {
    if (collection === 'spaces') continue;
    if (data[collection].length !== 0) return false;
  }
  return Object.keys(data.hub).length === 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function corruptStamp(now: Date): string {
  return now().toISOString().replaceAll(':', '-');
}

function openDatabase(file: string): DatabaseSync {
  return new DatabaseSync(file);
}

function configureDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
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

/** Move an unreadable database aside so a fresh one can start. */
async function backupCorruptDatabase(
  file: string,
  now: () => Date,
  logger: SpaceStoreLogger,
): Promise<string> {
  const stamp = corruptStamp(now);
  const target = `${file}.corrupt-${stamp}`;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      await rename(candidate, `${target}${candidate.slice(file.length)}`);
    } catch {
      // Missing files are fine; the main database rename matters most.
    }
  }
  logger.warn?.(
    `[alter-dsh-space] Space 数据库损坏，已备份到 ${target} 并重建默认数据`,
  );
  return target;
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

function parseEntityRow(
  collection: Collection,
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
        upsert.close();
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
      hubUpsert.close();
    }
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

/** Replace every row in one transaction; used for first run, imports and legacy JSON. */
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
        insert.close();
      }
      upsertMeta.run(
        `${ORDER_PREFIX}${collection}`,
        JSON.stringify(data[collection].map((entity) => String(entity.id))),
      );
    }
    db.exec('DELETE FROM hub');
    const hubInsert = db.prepare('INSERT INTO hub (space_id, data) VALUES (?, ?)');
    try {
      for (const [spaceId, snapshot] of Object.entries(data.hub))
        hubInsert.run(spaceId, JSON.stringify(snapshot));
    } finally {
      hubInsert.close();
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
    upsertMeta.close();
  }
}

async function readLegacyJson(
  directory: string,
  logger: SpaceStoreLogger,
): Promise<SpaceStoreData | undefined> {
  const file = join(directory, LEGACY_JSON_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const data = parseSpaceStoreData(parsed);
    if (!data) {
      logger.warn?.(
        `[alter-dsh-space] 旧版 ${LEGACY_JSON_FILE} 无法解析，已忽略（文件保留）`,
      );
      return undefined;
    }
    return data;
  } catch {
    logger.warn?.(
      `[alter-dsh-space] 旧版 ${LEGACY_JSON_FILE} 不是合法 JSON，已忽略（文件保留）`,
    );
    return undefined;
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

function countEntities(data: SpaceStoreData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const collection of COLLECTIONS) counts[collection] = data[collection].length;
  counts.hubs = Object.keys(data.hub).length;
  return counts;
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

  let db = openDatabase(file);
  configureDatabase(db);
  let recovered = false;
  try {
    if (!quickCheck(db)) recovered = true;
  } catch {
    recovered = true;
  }
  if (recovered) {
    try {
      db.close();
    } catch {
      // Ignore close failure after a corrupt read.
    }
    await backupCorruptDatabase(file, now, logger);
    db = openDatabase(file);
    configureDatabase(db);
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
  }

  const fresh = isDatabaseEmpty(db);
  let data: SpaceStoreData;
  if (fresh) {
    const legacy = await readLegacyJson(options.directory, logger);
    if (legacy) {
      data = legacy;
      logger.info?.(
        `[alter-dsh-space] 已把旧版 ${LEGACY_JSON_FILE} 导入 ${SPACE_DB_FILE}`,
      );
    } else {
      data = createDefaultData(now());
    }
    persistAll(db, data);
    await setFileMode(file);
  } else {
    data = readDatabase(db, now);
  }

  const persisted = snapshotPersisted(data);
  const orderSnapshot = new Map<Collection, string[]>();
  for (const collection of COLLECTIONS)
    orderSnapshot.set(
      collection,
      data[collection].map((entity) => String(entity.id)),
    );

  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  function update<T>(change: (value: SpaceStoreData) => T): Promise<T> {
    if (closed) return Promise.reject(new Error('Space 数据已关闭'));
    const run = queue.then(async () => {
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
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    file,
    read: () => data,
    update,
    isEmpty: () => isPristineSpaceData(data),
    importData(database: SpaceStoreData) {
      const total = COLLECTIONS.reduce(
        (sum, collection) => sum + database[collection].length,
        0,
      );
      if (total > MAX_IMPORT_ENTITIES)
        throw new Error('导入数据量超过上限，已拒绝');
      return update((value) => {
        if (!isPristineSpaceData(value)) {
          return { imported: false, reason: 'host-not-empty' as const };
        }
        value.version = 1;
        for (const collection of COLLECTIONS) {
          const replacement = database[collection].slice();
          Object.assign(value, { [collection]: replacement });
        }
        value.hub = { ...database.hub };
        return { imported: true as const, counts: countEntities(database) };
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
