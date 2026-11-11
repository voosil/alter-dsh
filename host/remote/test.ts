/**
 * Reachability and compatibility probe for a candidate Space server.
 *
 * Used by the settings page's "test connection" action and by the Agent
 * settings tool before committing a new server URL.
 *
 * @module @alter-dsh/space/remote/test
 */
import { SPACE_PROTOCOL_VERSION } from '../protocol.js';
import { SPACE_DB_FORMAT_VERSION } from '../store.js';
import { RemoteClientError, RemoteSpaceClient } from './client.js';

/** Outcome of one probe; `ok` is false for transport, auth or version errors. */
export interface RemoteTestResult {
  ok: boolean;
  serverVersion?: string;
  protocolVersion?: number;
  databaseSchemaVersion?: number;
  /** Whether an authenticated call succeeded (only probed when a token exists). */
  authenticated?: boolean;
  /** Human-readable failure detail. */
  message?: string;
}

function describe(error: unknown): string {
  if (error instanceof RemoteClientError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Probe one server URL, optionally verifying a token with an authenticated
 * read. Version facts come from the public `/version` route.
 */
export async function testRemoteServer(options: {
  serverUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<RemoteTestResult> {
  const token = options.token ?? '';
  let client: RemoteSpaceClient;
  try {
    client = new RemoteSpaceClient({
      baseUrl: options.serverUrl,
      token,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      timeoutMs: 8_000,
    });
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
  let info;
  try {
    info = await client.version();
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
  if (info.protocolVersion !== SPACE_PROTOCOL_VERSION)
    return {
      ok: false,
      serverVersion: info.version,
      protocolVersion: info.protocolVersion,
      databaseSchemaVersion: info.databaseSchemaVersion,
      message: `服务端协议版本 ${String(info.protocolVersion)} 与插件 ${String(
        SPACE_PROTOCOL_VERSION,
      )} 不兼容`,
    };
  if (info.databaseSchemaVersion > SPACE_DB_FORMAT_VERSION)
    return {
      ok: false,
      serverVersion: info.version,
      protocolVersion: info.protocolVersion,
      databaseSchemaVersion: info.databaseSchemaVersion,
      message: `服务端数据库结构版本 ${String(
        info.databaseSchemaVersion,
      )} 高于插件支持的 ${String(SPACE_DB_FORMAT_VERSION)}`,
    };
  if (token === '')
    return {
      ok: true,
      serverVersion: info.version,
      protocolVersion: info.protocolVersion,
      databaseSchemaVersion: info.databaseSchemaVersion,
      authenticated: false,
    };
  try {
    await client.call('space.listSpaces', []);
  } catch (error) {
    return {
      ok: false,
      serverVersion: info.version,
      protocolVersion: info.protocolVersion,
      databaseSchemaVersion: info.databaseSchemaVersion,
      authenticated: false,
      message: describe(error),
    };
  }
  return {
    ok: true,
    serverVersion: info.version,
    protocolVersion: info.protocolVersion,
    databaseSchemaVersion: info.databaseSchemaVersion,
    authenticated: true,
  };
}
