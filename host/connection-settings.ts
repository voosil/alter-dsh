/**
 * Host-owned connection settings for the two Space authority modes.
 *
 * The local file stores only the non-secret choice (`local` vs a server URL);
 * the bearer token lives in the DSH credential store when available and in a
 * `0600` file beside the settings otherwise. Both files live in the local
 * Space data directory and never reach the browser.
 *
 * @module @alter-dsh/space/connection-settings
 */
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

/** Which authority the plugin currently uses. */
export type SpaceAuthorityMode = 'local' | 'server';

/** One persisted, non-secret connection choice. */
export interface ConnectionSettings {
  mode: SpaceAuthorityMode;
  /** Normalized server base URL; `null` in local mode or before first setup. */
  serverUrl: string | null;
  /** ISO instant of the last persisted change. */
  updatedAt: string;
}

/** Loaded settings plus the resident token used by the bridge. */
export interface LoadedConnectionSettings {
  settings: ConnectionSettings;
  /** Bearer token, undefined while none is configured. */
  token: string | undefined;
}

/** Non-secret view returned to the settings page. */
export interface ConnectionSettingsView {
  mode: SpaceAuthorityMode;
  serverUrl: string | null;
  tokenConfigured: boolean;
  updatedAt: string;
}

/** Settings patch accepted from the settings page or an Agent tool. */
export interface ConnectionSettingsPatch {
  mode?: unknown;
  serverUrl?: unknown;
  /** `undefined` keeps the token; `null` clears it; a string replaces it. */
  token?: unknown;
}

/** A settings failure with a stable business code. */
export class ConnectionSettingsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectionSettingsError';
    this.code = code;
  }
}

/** Structural credential-record shape this plugin stores. */
export interface StoredTokenRecord {
  kind: 'grant';
  payload: { token: string };
}

/**
 * Structural subset of the DSH credentials service. The record is opaque to
 * the seam; this plugin only interprets its own `grant` payload.
 */
export interface CredentialStoreLike {
  readRecord(
    key: string,
  ): Promise<{ kind: string; payload?: unknown } | undefined>;
  modifyRecord(
    key: string,
    mutate: (
      current: { kind: string; payload?: unknown } | undefined,
    ) => Promise<{ kind: 'grant'; payload: { token: string } } | undefined>,
  ): Promise<unknown>;
  deleteRecord(key: string): Promise<void>;
}

/** Credential key owned by this plugin. */
export const SPACE_TOKEN_CREDENTIAL_KEY = 'alter-dsh-space/server-token';

/** Settings files inside the local Space data directory. */
export const CONNECTION_SETTINGS_FILE = 'connection.json';
export const CONNECTION_TOKEN_FILE = 'connection.secret.json';

const TEMP_FILE = /^\..+\.tmp$/;

interface LoggerLike {
  warn?(message: string): void;
}

interface SettingsFileShape {
  mode?: unknown;
  serverUrl?: unknown;
  updatedAt?: unknown;
}

function isMode(value: unknown): value is SpaceAuthorityMode {
  return value === 'local' || value === 'server';
}

/** Normalize one candidate server URL or reject it. */
export function normalizeServerUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new ConnectionSettingsError(
      'settings/invalid',
      '服务器地址必须是字符串或 null',
    );
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConnectionSettingsError(
      'settings/invalid',
      '服务器地址不是合法 URL',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new ConnectionSettingsError(
      'settings/invalid',
      '服务器地址必须使用 http 或 https',
    );
  if (parsed.username !== '' || parsed.password !== '')
    throw new ConnectionSettingsError(
      'settings/invalid',
      '服务器地址不能包含用户名或密码',
    );
  if (parsed.search !== '' || parsed.hash !== '')
    throw new ConnectionSettingsError(
      'settings/invalid',
      '服务器地址不能包含查询参数或锚点',
    );
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

function normalizeToken(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new ConnectionSettingsError('settings/invalid', 'token 必须是字符串');
  const trimmed = value.trim();
  if (trimmed === '')
    throw new ConnectionSettingsError('settings/invalid', 'token 不能为空');
  return trimmed;
}

/** Atomic, permission-restricted JSON write used by both files. */
async function writePrivateJson(
  file: string,
  value: unknown,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove leftover temp files from a previous crash; best effort. */
async function sweepTemp(directory: string): Promise<void> {
  try {
    for (const name of await readdir(directory)) {
      if (TEMP_FILE.test(name)) await rm(join(directory, name), { force: true });
    }
  } catch {
    // Cleanup is best effort; a stale temp file never blocks startup.
  }
}

/**
 * Host-side connection settings + token store.
 */
export interface ConnectionSettingsStore {
  /** Load persisted settings and the resident token. */
  load(): Promise<LoadedConnectionSettings>;
  /** Persist a validated patch and return the merged result. */
  save(patch: ConnectionSettingsPatch): Promise<LoadedConnectionSettings>;
  /** Non-secret view for the settings page and Agent tools. */
  view(): Promise<ConnectionSettingsView>;
  /** Replace the resident token without touching the mode/URL. */
  setToken(token: string | null): Promise<void>;
}

/**
 * Build the store for one local data directory.
 * @param options - data directory, clock and optional credential store.
 */
export function createConnectionSettingsStore(options: {
  directory: string;
  now?: () => Date;
  credentials?: CredentialStoreLike;
  logger?: LoggerLike;
}): ConnectionSettingsStore {
  const { directory } = options;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? {};
  const settingsPath = join(directory, CONNECTION_SETTINGS_FILE);
  const tokenPath = join(directory, CONNECTION_TOKEN_FILE);

  async function readSettingsFile(): Promise<ConnectionSettings> {
    let text: string;
    try {
      text = await readFile(settingsPath, 'utf8');
    } catch {
      return { mode: 'local', serverUrl: null, updatedAt: now().toISOString() };
    }
    try {
      const parsed = JSON.parse(text) as SettingsFileShape;
      const mode = isMode(parsed.mode) ? parsed.mode : 'local';
      const serverUrl =
        parsed.serverUrl === null || parsed.serverUrl === undefined
          ? null
          : normalizeServerUrl(parsed.serverUrl);
      const updatedAt =
        typeof parsed.updatedAt === 'string' && parsed.updatedAt !== ''
          ? parsed.updatedAt
          : now().toISOString();
      return { mode, serverUrl, updatedAt };
    } catch (error) {
      logger.warn?.(
        `[alter-dsh-space] connection.json 损坏，已回退本地模式：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { mode: 'local', serverUrl: null, updatedAt: now().toISOString() };
    }
  }

  async function readFileToken(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(tokenPath, 'utf8'),
      ) as { token?: unknown };
      return typeof parsed.token === 'string' && parsed.token.trim() !== ''
        ? parsed.token.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function readCredentialToken(): Promise<string | undefined> {
    if (options.credentials === undefined) return undefined;
    try {
      const record = await options.credentials.readRecord(
        SPACE_TOKEN_CREDENTIAL_KEY,
      );
      const payload = record?.payload;
      if (typeof payload !== 'object' || payload === null) return undefined;
      const token = (payload as { token?: unknown }).token;
      return typeof token === 'string' && token.trim() !== ''
        ? token.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function readToken(): Promise<string | undefined> {
    return (await readCredentialToken()) ?? (await readFileToken());
  }

  async function writeToken(token: string | null): Promise<void> {
    if (options.credentials !== undefined) {
      try {
        if (token === null) {
          await options.credentials.deleteRecord(SPACE_TOKEN_CREDENTIAL_KEY);
        } else {
          await options.credentials.modifyRecord(
            SPACE_TOKEN_CREDENTIAL_KEY,
            async () => ({ kind: 'grant', payload: { token } }),
          );
        }
        // The file copy is stale once the credential store owns the token.
        await rm(tokenPath, { force: true }).catch(() => undefined);
        return;
      } catch (error) {
        logger.warn?.(
          `[alter-dsh-space] 写入 DSH credentials 失败，回退本地文件：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (token === null) {
      await rm(tokenPath, { force: true }).catch(() => undefined);
      return;
    }
    await writePrivateJson(tokenPath, { token }, directory);
  }

  async function load(): Promise<LoadedConnectionSettings> {
    const settings = await readSettingsFile();
    return { settings, token: await readToken() };
  }

  async function save(
    patch: ConnectionSettingsPatch,
  ): Promise<LoadedConnectionSettings> {
    const current = await load();
    const nextMode =
      patch.mode === undefined
        ? current.settings.mode
        : isMode(patch.mode)
          ? patch.mode
          : (() => {
              throw new ConnectionSettingsError(
                'settings/invalid',
                'mode 只能是 local 或 server',
              );
            })();
    const nextUrl =
      patch.serverUrl === undefined
        ? current.settings.serverUrl
        : normalizeServerUrl(patch.serverUrl);
    const normalizedToken = normalizeToken(patch.token);
    const nextToken =
      normalizedToken === undefined
        ? current.token
        : normalizedToken === null
          ? undefined
          : normalizedToken;
    if (nextMode === 'server') {
      if (nextUrl === null)
        throw new ConnectionSettingsError(
          'settings/not-configured',
          '服务端模式需要配置服务器地址',
        );
      if (nextToken === undefined)
        throw new ConnectionSettingsError(
          'settings/not-configured',
          '服务端模式需要配置 token',
        );
    }
    const next: ConnectionSettings = {
      mode: nextMode,
      serverUrl: nextUrl,
      updatedAt: now().toISOString(),
    };
    await writePrivateJson(settingsPath, next, directory);
    if (normalizedToken !== undefined) await writeToken(normalizedToken);
    void sweepTemp(directory);
    return { settings: next, token: nextToken };
  }

  async function view(): Promise<ConnectionSettingsView> {
    const loaded = await load();
    return {
      mode: loaded.settings.mode,
      serverUrl: loaded.settings.serverUrl,
      tokenConfigured: loaded.token !== undefined,
      updatedAt: loaded.settings.updatedAt,
    };
  }

  async function setToken(token: string | null): Promise<void> {
    await writeToken(token);
  }

  return { load, save, view, setToken };
}
