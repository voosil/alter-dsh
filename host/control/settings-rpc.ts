/**
 * Settings/sync endpoints served by the plugin core rather than by an
 * authority backend: mode selection, server URL/token, connection tests and
 * queue status must work even while the server link is down.
 *
 * @module @alter-dsh/space/control/settings-rpc
 */
import type { BackendConnectionStatus } from '../core/backend.js';
import type { ConnectionAudit } from './connection-audit.js';
import {
  ConnectionSettingsError,
  normalizeServerUrl,
  type ConnectionSettingsStore,
} from './connection-settings.js';
import type { SpaceModeController } from '../core/mode.js';
import type { SpaceRpcHandler } from '../authority/rpc.js';
import type { SyncQueueEntry } from '../remote/bridge.js';
import { readRemoteQueueCounts } from '../remote/cache.js';
import { testRemoteServer, type RemoteTestResult } from '../remote/test.js';

/** Non-secret state shared by the settings page and the Agent settings tool. */
export interface SpaceSettingsState {
  mode: 'local' | 'server';
  serverUrl: string | null;
  tokenConfigured: boolean;
  updatedAt: string;
  connection: BackendConnectionStatus;
  capabilities: {
    remoteDirectories: boolean;
    workspaceMapping: boolean;
    agentConfigurable: boolean;
  };
  sync: {
    pendingWrites: number;
    conflicts: number;
    failed: number;
    lastSyncedAt?: string;
    /** Per-document unsettled queue rows (retry/discard entry point). */
    entries: SyncQueueEntry[];
  };
}

/** Dependencies for the settings endpoints. */
export interface SettingsRpcDeps {
  settings: ConnectionSettingsStore;
  mode: SpaceModeController;
  /** Local data directory (owns the per-server queue cache files). */
  directory: string;
  /** Optional append-only audit trail for user-initiated changes. */
  audit?: ConnectionAudit;
  /** Whether a migration job currently owns the authority window. */
  isMigrationRunning?: () => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argsOf(payload: unknown): unknown[] {
  if (!isPlainObject(payload)) return [];
  const args = payload.args;
  return Array.isArray(args) ? args : [];
}

function errorOf(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof ConnectionSettingsError)
    return { error: { code: error.code, message: error.message } };
  return {
    error: {
      code: 'settings/failed',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Build the settings/sync handler for the plugin route.
 * @param deps - settings store and the live mode controller.
 */
export function createSettingsRpcHandler(
  deps: SettingsRpcDeps,
): SpaceRpcHandler {
  async function buildState(): Promise<SpaceSettingsState> {
    const view = await deps.settings.view();
    const connection = deps.mode.status();
    const queued =
      connection.pendingWrites === undefined && view.serverUrl !== null
        ? await Promise.resolve(
            readRemoteQueueCounts(deps.directory, view.serverUrl),
          ).catch(() => undefined)
        : undefined;
    const entries =
      view.mode === 'server' ? deps.mode.queueEntries() : [];
    return {
      mode: view.mode,
      serverUrl: view.serverUrl,
      tokenConfigured: view.tokenConfigured,
      updatedAt: view.updatedAt,
      connection,
      capabilities: {
        remoteDirectories: view.mode === 'server',
        workspaceMapping: view.mode === 'local',
        agentConfigurable: true,
      },
      sync: {
        pendingWrites: connection.pendingWrites ?? queued?.pending ?? 0,
        conflicts: connection.conflicts ?? queued?.conflicts ?? 0,
        failed: connection.failed ?? queued?.failed ?? 0,
        ...(connection.lastSyncedAt === undefined
          ? {}
          : { lastSyncedAt: connection.lastSyncedAt }),
        entries,
      },
    };
  }

  /**
   * Refuse a mode change that would silently strand data.
   *
   * Moving to the server or back to local replaces the authority for every
   * document, so it must go through a migration (or an explicit discard of
   * the data that is left behind). A bare mode flip is what the settings
   * page used to send and it dropped the remote queue without asking.
   */
  function guardDirection(
    previousMode: 'local' | 'server',
    nextMode: 'local' | 'server',
    explicit: unknown,
  ): void {
    if (previousMode === nextMode || explicit === true) return;
    if (nextMode === 'server')
      throw new ConnectionSettingsError(
        'settings/migration-required',
        '从本地切到服务端需要先执行「数据迁移 → 本地 → 服务端」，或显式确认放弃本地数据',
      );
    throw new ConnectionSettingsError(
      'settings/migration-required',
      '从服务端切回本地需要先执行「数据迁移 → 服务端 → 本地」，或显式确认放弃服务端数据',
    );
  }

  return async (endpoint, payload) => {
    try {
      if (endpoint === 'settings.get')
        return { value: await buildState() };
      if (endpoint === 'settings.update') {
        if (deps.isMigrationRunning?.() === true)
          throw new ConnectionSettingsError(
            'migration/busy',
            '迁移进行中，暂时不能修改服务器配置或切换模式',
          );
        const patch = argsOf(payload)[0];
        if (!isPlainObject(patch))
          throw new ConnectionSettingsError(
            'settings/invalid',
            '设置更新参数必须是对象',
          );
        const previous = await deps.settings.load();
        const before = await deps.settings.view();
        const nextMode =
          patch.mode === undefined
            ? previous.settings.mode
            : patch.mode === 'local' || patch.mode === 'server'
              ? patch.mode
              : (() => {
                  throw new ConnectionSettingsError(
                    'settings/invalid',
                    'mode 只能是 local 或 server',
                  );
                })();
        guardDirection(previous.settings.mode, nextMode, patch.discard);
        const loaded = await deps.settings.save(patch);
        try {
          await deps.mode.apply(loaded);
        } catch (error) {
          // A failed switch keeps the old backend alive, so the persisted
          // choice must be rolled back too or the panel and the next start
          // would disagree about the authority.
          await deps.settings
            .save({
              mode: previous.settings.mode,
              serverUrl: previous.settings.serverUrl,
            })
            .catch(() => undefined);
          await deps.settings.setToken(previous.token ?? null).catch(
            () => undefined,
          );
          throw error;
        }
        const after = await deps.settings.view();
        deps.audit?.record({
          actor: 'user',
          action:
            before.mode !== after.mode || before.serverUrl !== after.serverUrl
              ? 'server'
              : 'token',
          from: before.serverUrl,
          to: after.serverUrl,
          result: 'ok',
        });
        return { value: await buildState() };
      }
      if (endpoint === 'settings.test') {
        const input = argsOf(payload)[0];
        if (!isPlainObject(input))
          throw new ConnectionSettingsError(
            'settings/invalid',
            '连接测试参数必须是对象',
          );
        const loaded = await deps.settings.load();
        const rawUrl = input.serverUrl ?? loaded.settings.serverUrl;
        if (rawUrl === null || rawUrl === undefined)
          throw new ConnectionSettingsError(
            'settings/invalid',
            '连接测试需要服务器地址',
          );
        const serverUrl = normalizeServerUrl(rawUrl);
        if (serverUrl === null)
          throw new ConnectionSettingsError(
            'settings/invalid',
            '连接测试需要服务器地址',
          );
        const targetsConfiguredServer =
          loaded.settings.serverUrl !== null &&
          serverUrl === loaded.settings.serverUrl;
        const token =
          input.token === null
            ? undefined
            : typeof input.token === 'string' && input.token.trim() !== ''
              ? input.token.trim()
              : targetsConfiguredServer
                ? loaded.token
                : undefined;
        const result: RemoteTestResult = await testRemoteServer({
          serverUrl,
          ...(token === undefined ? {} : { token }),
        });
        deps.audit?.record({
          actor: 'user',
          action: 'test',
          from: serverUrl,
          result: result.ok ? 'ok' : 'failed',
        });
        return { value: result };
      }
      if (endpoint === 'sync.status')
        return { value: await buildState() };
      if (endpoint === 'sync.queue')
        return { value: deps.mode.queueEntries() };
      if (endpoint === 'sync.resolve') {
        if (deps.isMigrationRunning?.() === true)
          throw new ConnectionSettingsError(
            'migration/busy',
            '迁移进行中，不能处理待同步写入',
          );
        const input = argsOf(payload)[0];
        if (!isPlainObject(input))
          throw new ConnectionSettingsError(
            'settings/invalid',
            '处理待同步写入的参数必须是对象',
          );
        const docId = input.docId;
        const action = input.action;
        if (typeof docId !== 'string' || docId.trim() === '')
          throw new ConnectionSettingsError('settings/invalid', '需要 docId');
        if (action !== 'retry' && action !== 'discard')
          throw new ConnectionSettingsError(
            'settings/invalid',
            'action 只能是 retry 或 discard',
          );
        const result = await deps.mode.resolveQueue(docId, action);
        deps.audit?.record({
          actor: 'user',
          action: 'sync',
          from: docId,
          result: 'ok',
        });
        return { value: { ...result, state: await buildState() } };
      }
      if (endpoint === 'sync.flush') {
        if (deps.isMigrationRunning?.() === true)
          throw new ConnectionSettingsError(
            'migration/busy',
            '迁移进行中，不能重放待同步写入',
          );
        await deps.mode.flush();
        return { value: await buildState() };
      }
      if (endpoint.startsWith('settings.') || endpoint.startsWith('sync.'))
        throw new ConnectionSettingsError(
          'settings/not-found',
          `未知的接口 ${endpoint}`,
        );
      throw new ConnectionSettingsError(
        'settings/not-found',
        `设置处理器不支持的接口 ${endpoint}`,
      );
    } catch (error) {
      return errorOf(error);
    }
  };
}
