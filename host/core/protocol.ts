/**
 * Wire and package identity shared by the plugin and the standalone server.
 *
 * The protocol version guards the RPC surface (op names, envelope shape and
 * result encoding); the database schema version is reported for diagnostics
 * and migration preflight.
 *
 * @module @alter-dsh/space/core/protocol
 */
import { readFileSync } from 'node:fs';

/** Wire protocol version; bump when RPC endpoints or envelopes change. */
export const SPACE_PROTOCOL_VERSION = 1;
/** Product package name reported by `/version`. */
export const SPACE_PRODUCT_NAME = '@alter-dsh/space';

/** Identity facts a client uses to reject an incompatible server early. */
export interface SpaceServerInfo {
  product: string;
  /** Package version of the server runtime. */
  version: string;
  /** Wire protocol version. */
  protocolVersion: number;
  /** SQLite schema version the server runtime understands. */
  databaseSchemaVersion: number;
}

/**
 * Read the package version from the nearest `package.json` that names this
 * product. The same code runs from `host/` (source) and `lib/host/` (build),
 * so both layouts are probed; a missing file falls back to `0.0.0` instead of
 * failing the health path.
 */
export function readSpacePackageVersion(): string {
  for (const candidate of [
    '../package.json',
    '../../package.json',
    '../../../package.json',
  ]) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(new URL(candidate, import.meta.url), 'utf8'),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { name?: unknown }).name === SPACE_PRODUCT_NAME &&
        typeof (parsed as { version?: unknown }).version === 'string'
      ) {
        return (parsed as { version: string }).version;
      }
    } catch {
      // Try the next layout; health must not depend on the file existing.
    }
  }
  return '0.0.0';
}

/** Compose `/version` and health identity for a server runtime. */
export function spaceServerInfo(
  databaseSchemaVersion: number,
): SpaceServerInfo {
  return {
    product: SPACE_PRODUCT_NAME,
    version: readSpacePackageVersion(),
    protocolVersion: SPACE_PROTOCOL_VERSION,
    databaseSchemaVersion,
  };
}
