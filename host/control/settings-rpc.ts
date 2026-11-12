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
  normalizeToken,
  type ConnectionSettingsStore,
  type ConnectionSettingsView,
} from './connection-settings.js';
import type { SpaceModeController } from '../core/mode.js';
import type { SpaceRpcHandler } from '../authority/rpc.js';
import type { SyncQueueEntry } from '../remote/bridge.js';
import {
  readRemoteQueueCounts,
  removeRemoteCache,
  type QueueCounts,
} from '../remote/cache.js';
import { RemoteClientError } from '../remote/client.js';
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
  // RemoteClientError carries the stable remote/* codes the spec promises
  // (`sync.resolve` offline → remote/unavailable); flattening them to
  // settings/failed hid the retryable condition from the browser.
  if (error instanceof RemoteClientError)
    return { error: { code: error.code, message: error.message } };
  return {
    error: {
      code: 'settings/failed',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/** One validated connection-settings change, before it is committed. */
export interface ConnectionPatchReview {
  /** Who asked for the change. */
  actor: 'user' | 'agent';
  previousMode: 'local' | 'server';
  nextMode: 'local' | 'server';
  previousServerUrl: string | null;
  nextServerUrl: string | null;
  modeChanged: boolean;
  serverUrlChanged: boolean;
  /** Whether the change writes or clears the bearer token. */
  tokenChanged: boolean;
  /** Explicit acknowledgement of the data being abandoned. */
  discard: boolean;
  /** Unsettled queue rows under the old server scope. */
  queue: QueueCounts;
  /** Why an explicit discard is required, when it is. */
  discardReason?: string;
}

/** Approval outcome returned by the Agent approval service. */
export type ConnectionApprovalOutcome =
  | 'allowed-once'
  | 'rejected'
  | 'cancelled'
  | 'unavailable';

/**
 * Ask the user to approve one sensitive connection change. The settings page
 * confirms in its own UI and passes no callback; the Agent tool supplies the
 * DSH approval flow.
 */
export type ConnectionApproval = (
  review: ConnectionPatchReview,
) => Promise<ConnectionApprovalOutcome>;

/** Dependencies of {@link applyConnectionPatch}. */
export interface ApplyConnectionPatchOptions {
  settings: ConnectionSettingsStore;
  mode: SpaceModeController;
  /** Local data directory that owns the per-server queue/cache files. */
  directory: string;
  /** Audit attribution. */
  actor: 'user' | 'agent';
  audit?: ConnectionAudit;
  /** Whether a migration job currently owns the authority window. */
  isMigrationRunning?: () => boolean;
  /** Approval gate for mode/URL/token changes (Agent tool only). */
  approval?: ConnectionApproval;
}

/** One committed connection change. */
export interface AppliedConnectionPatch {
  before: ConnectionSettingsView;
  view: ConnectionSettingsView;
  review: ConnectionPatchReview;
  /** Old server scope whose cache/queue was removed, when it was. */
  clearedServerUrl: string | null;
}

/** Refuse a settings write while a migration owns the authority window. */
function assertNotMigrationBusy(
  options: Pick<ApplyConnectionPatchOptions, 'mode' | 'isMigrationRunning'>,
): void {
  const running = options.isMigrationRunning?.() === true;
  const mode = options.mode as Partial<SpaceModeController>;
  const locked =
    typeof mode.isMigrationLocked === 'function' && mode.isMigrationLocked();
  if (running || locked)
    throw new ConnectionSettingsError(
      'migration/busy',
      '迁移进行中，暂时不能修改服务器配置或切换模式',
    );
}

function changedModeOf(value: unknown): 'local' | 'server' {
  if (value === 'local' || value === 'server') return value;
  throw new ConnectionSettingsError('settings/invalid', 'mode 只能是 local 或 server');
}

/**
 * Validate, authorize and commit one connection-settings patch.
 *
 * Shared by the settings RPC (browser, already confirmed in the page UI) and
 * the Agent `space_settings` tool (needs the approval flow): both must apply
 * the same migration lock, mode-switch guard, unsettled-queue guard, backend
 * switch/rollback and audit trail.
 *
 * A mode switch always requires `discard: true` because it replaces the
 * authority for every document. Changing `serverUrl` in server mode requires
 * it too while the old server scope still has queued writes, which would
 * otherwise be orphaned in a cache file nobody addresses again.
 *
 * @param rawPatch - caller-supplied patch (`mode`/`serverUrl`/`token`/`discard`).
 * @param options - store, mode controller and audit/approval seams.
 * @returns the committed view plus what actually changed.
 */
export async function applyConnectionPatch(
  rawPatch: unknown,
  options: ApplyConnectionPatchOptions,
): Promise<AppliedConnectionPatch> {
  if (!isPlainObject(rawPatch))
    throw new ConnectionSettingsError(
      'settings/invalid',
      '设置更新参数必须是对象',
    );
  assertNotMigrationBusy(options);
  const previous = await options.settings.load();
  const before = await options.settings.view();
  const nextMode =
    rawPatch.mode === undefined
      ? previous.settings.mode
      : changedModeOf(rawPatch.mode);
  const nextServerUrl =
    rawPatch.serverUrl === undefined
      ? previous.settings.serverUrl
      : normalizeServerUrl(rawPatch.serverUrl);
  const providedToken = normalizeToken(rawPatch.token);
  const nextToken =
    providedToken === undefined
      ? previous.token
      : (providedToken ?? undefined);
  if (nextMode === 'server') {
    if (nextServerUrl === null)
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
  const modeChanged = previous.settings.mode !== nextMode;
  const serverUrlChanged = previous.settings.serverUrl !== nextServerUrl;
  const tokenChanged = nextToken !== previous.token;
  const discard = rawPatch.discard === true;
  const queue =
    previous.settings.serverUrl === null
      ? { pending: 0, conflicts: 0, failed: 0 }
      : readRemoteQueueCounts(options.directory, previous.settings.serverUrl);
  const unsettled = queue.pending + queue.conflicts + queue.failed;
  let discardReason: string | undefined;
  if (modeChanged && !discard) {
    discardReason =
      nextMode === 'server'
        ? '从本地切到服务端需要先执行「数据迁移 → 本地 → 服务端」，或显式确认放弃本地数据'
        : '从服务端切回本地需要先执行「数据迁移 → 服务端 → 本地」，或显式确认放弃服务端数据';
  } else if (
    !modeChanged &&
    previous.settings.mode === 'server' &&
    serverUrlChanged &&
    unsettled > 0 &&
    !discard
  ) {
    discardReason = `旧服务器还有 ${String(unsettled)} 条尚未同步到服务端的本地写入；请先在「待同步写入」里处理，或显式确认放弃旧服务器的本地写入`;
  }
  if (discardReason !== undefined)
    throw new ConnectionSettingsError(
      'settings/migration-required',
      discardReason,
    );
  const review: ConnectionPatchReview = {
    actor: options.actor,
    previousMode: previous.settings.mode,
    nextMode,
    previousServerUrl: previous.settings.serverUrl,
    nextServerUrl,
    modeChanged,
    serverUrlChanged,
    tokenChanged,
    discard,
    queue,
    ...(discardReason === undefined ? {} : { discardReason }),
  };
  const sensitive = modeChanged || serverUrlChanged || tokenChanged;
  if (!sensitive) return { before, view: before, review, clearedServerUrl: null };
  const auditAction = (): 'mode' | 'server' | 'token' =>
    modeChanged ? 'mode' : serverUrlChanged ? 'server' : 'token';
  if (options.approval !== undefined) {
    const outcome = await options.approval(review);
    if (outcome !== 'allowed-once') {
      options.audit?.record({
        actor: options.actor,
        action: auditAction(),
        from: modeChanged ? before.mode : before.serverUrl,
        to: modeChanged ? nextMode : nextServerUrl,
        tokenChanged,
        result: 'rejected',
      });
      throw new ConnectionSettingsError(
        'settings/approval-required',
        `用户未批准修改 Space 服务器配置（${outcome}）`,
      );
    }
  }
  const loaded = await options.settings.save({
    mode: nextMode,
    serverUrl: nextServerUrl,
    ...(providedToken === undefined ? {} : { token: providedToken }),
  });
  // A local-mode settings edit only changes what the next switch will use; it
  // must not restart the local SQLite authority on every save.
  const backendChanged =
    modeChanged || (nextMode === 'server' && (serverUrlChanged || tokenChanged));
  if (backendChanged) {
    try {
      await options.mode.apply(loaded);
    } catch (error) {
      // A failed switch keeps the old backend alive, so the persisted choice
      // must be rolled back too or the panel and the next start would disagree
      // about the authority.
      await options.settings
        .save({
          mode: previous.settings.mode,
          serverUrl: previous.settings.serverUrl,
          token: previous.token ?? null,
        })
        .catch(() => undefined);
      options.audit?.record({
        actor: options.actor,
        action: auditAction(),
        from: modeChanged ? before.mode : before.serverUrl,
        to: modeChanged ? nextMode : nextServerUrl,
        tokenChanged,
        result: 'failed',
      });
      throw error;
    }
  }
  const after = await options.settings.view();
  if (modeChanged)
    options.audit?.record({
      actor: options.actor,
      action: 'mode',
      from: before.mode,
      to: after.mode,
      tokenChanged,
      result: 'ok',
    });
  if (serverUrlChanged)
    options.audit?.record({
      actor: options.actor,
      action: 'server',
      from: before.serverUrl,
      to: after.serverUrl,
      tokenChanged,
      result: 'ok',
    });
  if (tokenChanged)
    options.audit?.record({
      actor: options.actor,
      action: 'token',
      tokenChanged: true,
      result: 'ok',
    });
  // The old server scope is no longer addressed by this plugin: its read
  // cache is stale and a queue left behind would never be replayed. Unsettled
  // writes are user content, not disposable cache, so they only go away with
  // the explicit discard required above (a local-mode URL change skips that
  // guard, so it must leave the orphaned file untouched).
  let clearedServerUrl: string | null = null;
  const oldServerUrl = previous.settings.serverUrl;
  const mayClearOldScope = unsettled === 0 || discard;
  if (
    oldServerUrl !== null &&
    mayClearOldScope &&
    (serverUrlChanged || (modeChanged && nextMode === 'local'))
  ) {
    await removeRemoteCache(options.directory, oldServerUrl);
    clearedServerUrl = oldServerUrl;
    options.audit?.record({
      actor: options.actor,
      action: 'sync',
      from: oldServerUrl,
      to: null,
      result: 'ok',
    });
  }
  return { before, view: after, review, clearedServerUrl };
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

  return async (endpoint, payload) => {
    try {
      if (endpoint === 'settings.get')
        return { value: await buildState() };
      if (endpoint === 'settings.update') {
        await applyConnectionPatch(argsOf(payload)[0], {
          settings: deps.settings,
          mode: deps.mode,
          directory: deps.directory,
          actor: 'user',
          ...(deps.audit === undefined ? {} : { audit: deps.audit }),
          ...(deps.isMigrationRunning === undefined
            ? {}
            : { isMigrationRunning: deps.isMigrationRunning }),
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
      // The plugin route sends every `settings.*` / `sync.*` endpoint here
      // (including unknown methods, so the migration freeze cannot silently
      // judge them read-only); they must fail with a stable business code.
      throw new ConnectionSettingsError(
        'settings/not-found',
        `未知的设置接口 ${endpoint}`,
      );
    } catch (error) {
      return errorOf(error);
    }
  };
}
