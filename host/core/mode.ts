/**
 * Ownership of the active authority backend and live mode switches.
 *
 * One plugin activation registers its routes and tools once; this controller
 * makes them read whichever backend is current. A failed switch keeps the
 * previous backend alive so a bad URL/token cannot strand the panel.
 *
 * @module @alter-dsh/space/core/mode
 */
import {
  createLocalBackend,
  type BackendConnectionStatus,
  type SpaceBackend,
} from './backend.js';
import {
  ConnectionSettingsError,
  type ConnectionSettingsStore,
  type LoadedConnectionSettings,
} from '../control/connection-settings.js';
import { createRemoteBackend } from '../remote/backend.js';
import type { SyncQueueEntry } from '../remote/bridge.js';
import { RemoteClientError } from '../remote/client.js';
import { createLocalSpaceRuntime } from './runtime.js';
import type { SpaceStoreLogger } from '../persistence/store.js';
import type { SpaceWorkspaceSync } from '../workspace/sync.js';

/** Options for one mode controller. */
export interface SpaceModeOptions {
  directory: string;
  settings: ConnectionSettingsStore;
  now?: () => Date;
  logger?: SpaceStoreLogger;
  /** Live workspace-bridge resolver handed to the local backend. */
  workspaceSync?: () => SpaceWorkspaceSync | undefined;
}

export class SpaceModeError extends Error {
  /** `config` asks the caller to repair settings; `transient` may retry. */
  readonly kind: 'config' | 'transient';
  readonly cause?: unknown;

  constructor(kind: 'config' | 'transient', message: string, cause?: unknown) {
    super(message);
    this.name = 'SpaceModeError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** Human-readable message for one failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an error means the saved server configuration cannot be used. */
function classify(error: unknown): 'config' | 'transient' {
  if (error instanceof ConnectionSettingsError) return 'config';
  if (error instanceof RemoteClientError) {
    // The server answered but rejected the token, or answered with an
    // incompatible protocol: repairing settings is the only way forward.
    return error.code === 'remote/unauthorized' ||
      error.code === 'remote/protocol'
      ? 'config'
      : 'transient';
  }
  return 'transient';
}

/**
 * Owns the active backend and serializes switches.
 *
 * A failed switch keeps the previous backend alive, so a bad URL/token cannot
 * strand the panel. {@link SpaceModeController.open} can additionally fall
 * back to the local authority when the persisted server configuration is
 * unusable, and reports why through {@link SpaceModeController.degraded}.
 */
export class SpaceModeController {
  private readonly options: SpaceModeOptions;
  private backendValue: SpaceBackend | undefined;
  private readonly listeners = new Set<(backend: SpaceBackend) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private migrationLocked = false;
  private degradedValue: { reason: string; transient: boolean } | undefined;

  constructor(options: SpaceModeOptions) {
    this.options = options;
  }

  /**
   * Load persisted settings and open the matching backend.
   *
   * A transient failure (server unreachable at startup) keeps the configured
   * server mode and opens a remote backend that reports `offline`, so queued
   * writes and the chosen authority survive a reboot. Only a configuration
   * error falls back to local mode.
   *
   * Opening the remote backend does not probe the server, so a pure network
   * outage never fails this call and therefore never changes the mode. If even
   * the fallback cannot be opened (corrupt or unwritable local data
   * directory), activation degrades to the local authority and persists that
   * choice instead of rejecting plugin activation forever.
   */
  async open(): Promise<SpaceBackend> {
    const loaded = await this.options.settings.load();
    try {
      return await this.apply(loaded);
    } catch (error) {
      const kind = classify(error);
      const reason = messageOf(error);
      this.options.logger?.warn?.(
        `[alter-dsh-space] 配置的后端无法启动（${kind}）：${reason}`,
      );
      if (kind === 'config') {
        // Keep the file for inspection but stop claiming server mode: the
        // credentials or URL need repair before the remote authority works.
        await this.options.settings
          .save({ mode: 'local' })
          .catch(() => undefined);
        this.degradedValue = { reason, transient: false };
      } else {
        this.degradedValue = { reason, transient: true };
      }
      const fallback = await this.options.settings.load();
      try {
        return await this.apply(fallback);
      } catch (secondError) {
        if (fallback.settings.mode === 'local') {
          // Local was already the fallback target and it cannot open either:
          // there is no authority left to activate.
          throw secondError;
        }
        // The configured server authority cannot be opened on this machine
        // (for example an unusable cache directory). Retrying it next boot
        // would brick the plugin, so open the local authority for this boot
        // and persist that decision for the next one.
        const secondReason = messageOf(secondError);
        this.options.logger?.warn?.(
          `[alter-dsh-space] 服务端后端仍无法启动，改用本地模式：${secondReason}`,
        );
        this.degradedValue = {
          reason: `${reason}；改用本地模式：${secondReason}`,
          transient: false,
        };
        await this.options.settings
          .save({ mode: 'local' })
          .catch(() => undefined);
        return this.apply(this.localFallbackSettings());
      }
    }
  }

  /** A synthesized local settings pair, used when the persisted file cannot be trusted. */
  private localFallbackSettings(): LoadedConnectionSettings {
    const at = (this.options.now ?? (() => new Date()))().toISOString();
    return {
      settings: { mode: 'local', serverUrl: null, updatedAt: at },
      token: undefined,
    };
  }

  /** Why the last {@link open} fell back, when it did. */
  degraded(): { reason: string; transient: boolean } | undefined {
    return this.degradedValue;
  }

  /**
   * Switch to the backend named by `loaded`. The previous backend is only
   * closed after the replacement opened successfully.
   */
  async apply(loaded: LoadedConnectionSettings): Promise<SpaceBackend> {
    const run = this.queue.then(async () => {
      if (this.closed) throw new Error('Space 模式控制器已关闭');
      const next = await this.createBackend(loaded);
      if (this.closed) {
        // close() landed while the replacement was still opening; do not
        // strand an unowned backend that no later switch can release.
        await next.close().catch(() => undefined);
        throw new Error('Space 模式控制器已关闭');
      }
      const previous = this.backendValue;
      this.backendValue = next;
      if (previous !== undefined) {
        await previous.close().catch((error: unknown) => {
          this.options.logger?.warn?.(
            `[alter-dsh-space] 关闭旧后端失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      for (const listener of [...this.listeners]) {
        try {
          listener(next);
        } catch (error) {
          this.options.logger?.warn?.(
            `[alter-dsh-space] 后端切换监听失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The active backend; throws when called before {@link open}. */
  current(): SpaceBackend {
    if (this.backendValue === undefined)
      throw new Error('Space 后端尚未初始化');
    return this.backendValue;
  }

  /** Freeze every mutating Space call while a migration snapshot is taken. */
  setMigrationLock(locked: boolean): void {
    this.migrationLocked = locked;
  }

  /** Whether mutating calls are currently blocked by a migration. */
  isMigrationLocked(): boolean {
    return this.migrationLocked;
  }

  /** Current link/authority status, safe before the first open. */
  status(): BackendConnectionStatus {
    return this.backendValue?.status ?? { state: 'connecting' };
  }

  /** Re-probe the active remote link (no-op in local mode). */
  async refresh(): Promise<void> {
    await this.backendValue?.refresh?.();
  }

  /** Flush queued writes (no-op in local mode). */
  async flush(): Promise<void> {
    await this.backendValue?.flush?.();
  }

  /** Documents with unsettled queued writes; empty in local mode. */
  queueEntries(): SyncQueueEntry[] {
    return this.backendValue?.queueEntries?.() ?? [];
  }

  /** Retry or discard one document's unsettled writes (server mode only). */
  async resolveQueue(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<{ resolved: number }> {
    const backend = this.backendValue;
    if (backend?.resolveQueue === undefined)
      throw new ConnectionSettingsError(
        'sync/not-server',
        '只有服务端模式才有待同步写入需要处理',
      );
    return backend.resolveQueue(docId, action);
  }

  /** Subscribe to backend replacements; returns a disposer. */
  onChange(listener: (backend: SpaceBackend) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Close the active backend; further switches are rejected. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const current = this.backendValue;
    this.backendValue = undefined;
    await current?.close();
  }

  private async createBackend(
    loaded: LoadedConnectionSettings,
  ): Promise<SpaceBackend> {
    if (loaded.settings.mode === 'server') {
      const url = loaded.settings.serverUrl;
      const token = loaded.token;
      if (url === null)
        throw new ConnectionSettingsError(
          'settings/not-configured',
          '服务端模式缺少服务器地址',
        );
      if (token === undefined)
        throw new ConnectionSettingsError(
          'settings/not-configured',
          '服务端模式缺少 token',
        );
      return createRemoteBackend({
        baseUrl: url,
        token,
        directory: this.options.directory,
        pauseFlush: () => this.migrationLocked,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
        ...(this.options.logger === undefined
          ? {}
          : { logger: this.options.logger }),
      });
    }
    const runtime = await createLocalSpaceRuntime({
      directory: this.options.directory,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.logger === undefined
        ? {}
        : { logger: this.options.logger }),
    });
    return createLocalBackend({
      runtime,
      ...(this.options.workspaceSync === undefined
        ? {}
        : { workspaceSync: this.options.workspaceSync }),
    });
  }
}
