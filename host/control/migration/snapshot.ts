/**
 * Consistent SQLite snapshots for migration and diagnostics.
 *
 * Migration never copies a live database file: `VACUUM INTO` produces one
 * consistent copy (including committed WAL content) while the Host keeps
 * running. Device-local side tables (`workspace_links`) are stripped from the
 * copy, and an optional history trim keeps only the newest version per
 * document for users who accept losing older versions.
 *
 * @module @alter-dsh/space/control/migration/snapshot
 */
import { DatabaseSync } from 'node:sqlite';

/** Options for one snapshot. */
export interface SnapshotOptions {
  /** Keep only the newest version snapshot per document. */
  trimHistory?: boolean;
}

/** Diagnostics read from one database file. */
export interface DatabaseFacts {
  quickCheck: string;
  userVersion: number;
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: unknown } | undefined;
  return row !== undefined;
}

/**
 * Create a consistent, migration-ready copy of one Space database.
 * @param source - live `space.db` path.
 * @param destination - copy destination (replaced if present).
 * @param options - history trim switch.
 */
export function snapshotSpaceDatabase(
  source: string,
  destination: string,
  options: SnapshotOptions = {},
): void {
  const live = new DatabaseSync(source);
  try {
    live.exec('PRAGMA busy_timeout = 5000');
    live.exec(`VACUUM INTO '${escapeSql(destination)}'`);
  } finally {
    live.close();
  }
  const copy = new DatabaseSync(destination);
  try {
    if (hasTable(copy, 'workspace_links')) {
      // Workspace bindings are device-local; the target host owns its own.
      copy.exec('DELETE FROM workspace_links');
    }
    if (options.trimHistory === true && hasTable(copy, 'versions')) {
      copy.exec(`
        DELETE FROM versions WHERE rowid NOT IN (
          SELECT rowid FROM (
            SELECT rowid,
                   ROW_NUMBER() OVER (
                     PARTITION BY json_extract(data, '$.docId')
                     ORDER BY json_extract(data, '$.at') DESC
                   ) AS rank
            FROM versions
          ) WHERE rank <= 1
        )
      `);
    }
    copy.exec('PRAGMA journal_mode = DELETE');
  } finally {
    copy.close();
  }
}

/**
 * Read integrity and schema facts from one database file.
 * @param file - database path.
 */
export function readDatabaseFacts(file: string): DatabaseFacts {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get() as
      | { quick_check?: unknown }
      | undefined;
    const version = db.prepare('PRAGMA user_version').get() as
      | { user_version?: unknown }
      | undefined;
    return {
      quickCheck: typeof check?.quick_check === 'string' ? check.quick_check : 'unknown',
      userVersion: Number(version?.user_version ?? 0),
    };
  } finally {
    db.close();
  }
}

/** Row counts used by migration verification and empty-target checks. */
export interface SpaceDataCounts {
  spaces: number;
  nodes: number;
  thoughts: number;
  comments: number;
  versions: number;
  assets: number;
  events: number;
}

/**
 * Count business rows in one database without loading the whole store.
 * @param file - database path.
 */
export function readSpaceDataCounts(file: string): SpaceDataCounts {
  const counts: SpaceDataCounts = {
    spaces: 0,
    nodes: 0,
    thoughts: 0,
    comments: 0,
    versions: 0,
    assets: 0,
    events: 0,
  };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables: Array<[keyof SpaceDataCounts, string]> = [
      ['spaces', 'spaces'],
      ['nodes', 'nodes'],
      ['thoughts', 'thoughts'],
      ['comments', 'comments'],
      ['versions', 'versions'],
      ['assets', 'document_assets'],
      ['events', 'events'],
    ];
    for (const [key, table] of tables) {
      if (!hasTable(db, table)) continue;
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
        .get() as { c?: unknown } | undefined;
      counts[key] = Number(row?.c ?? 0);
    }
    return counts;
  } finally {
    db.close();
  }
}

/** Whether a Space database has no user-visible content yet. */
export function isEmptySpaceDatabase(file: string): boolean {
  const counts = readSpaceDataCounts(file);
  return (
    counts.nodes === 0 &&
    counts.thoughts === 0 &&
    counts.comments === 0 &&
    counts.versions === 0
  );
}
