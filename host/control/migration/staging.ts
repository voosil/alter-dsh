/**
 * Migration staging/backup housekeeping.
 *
 * Both directions stage data under `<dataDir>/.migration/`: uploaded import
 * parts, exported bundles and the backups that make a target replacement
 * reversible. A crashed or cancelled transfer leaves those directories behind;
 * replacing a database is not crash-safe, so backups must outlive the process
 * for manual recovery. The seven-day rule keeps a usable manual-recovery window
 * without letting abandoned multi-gigabyte staging grow forever.
 *
 * @module @alter-dsh/space/control/migration/staging
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Hidden directory (inside the Space data directory) that owns staging. */
export const MIGRATION_STAGING_DIR_NAME = '.migration';

/** Abandoned staging entries older than this are removed on startup. */
export const MIGRATION_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Absolute path of the migration staging directory for a data directory. */
export function migrationStagingDirectory(dataDirectory: string): string {
  return join(dataDirectory, MIGRATION_STAGING_DIR_NAME);
}

/**
 * Remove abandoned `.migration` staging and backup entries.
 *
 * Only entries whose directory mtime is older than seven days are removed; a
 * running transfer keeps touching the directory it owns, so its `tmp`/`parts`
 * children stay. Failures are swallowed per entry: housekeeping must never stop
 * the plugin or the server from starting.
 *
 * @param dataDirectory - Space data directory (the parent of `space.db`).
 */
export async function sweepMigrationStaging(
  dataDirectory: string,
): Promise<void> {
  const stagingRoot = migrationStagingDirectory(dataDirectory);
  let names: string[];
  try {
    names = await readdir(stagingRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - MIGRATION_STAGING_TTL_MS;
  for (const name of names) {
    const absolute = join(stagingRoot, name);
    try {
      if ((await stat(absolute)).mtimeMs >= cutoff) continue;
      await rm(absolute, { recursive: true, force: true });
    } catch {
      // A concurrent transfer may own the directory; leave it alone.
    }
  }
}