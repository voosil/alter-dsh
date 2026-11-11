/**
 * Ownership of the active authority backend and live mode switches.
 *
 * One plugin activation registers its routes and tools once; this controller
 * makes them read whichever backend is current. A failed switch keeps the
 * previous backend alive so a bad URL/token cannot strand the panel.
 *
 * @module @alter-dsh/space/mode
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
} from './connection-settings.js';
import { createRemoteBackend } from './remote/backend.js';
import { createLocalSpaceRuntime } from './runtime.js';
import type { SpaceStoreLogger } from './store.js';
import type { SpaceWorkspaceSync } from './workspace-sync.js';

/** Options for one mode controller. */
export interface SpaceModeOptions {
  directory: string;
  settings: ConnectionSettingsStore;
  now?: () => Date;
  logger?: SpaceStoreLogger;
  /** Live workspace-bridge resolver handed to the local backend. */
  workspaceSync?: () => SpaceWorkspaceSync | undefined;
}

/**
 * Owns the active backend and serializes switches.
 */
export class SpaceModeController {
  private readonly options: SpaceModeOptions;
  private backendValue: SpaceBackend | undefined;
  private readonly listeners = new Set<(backend: SpaceBackend) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private migrationLocked = false;

  constructor(options: SpaceModeOptions) {
    this.options = options;
  }

  /** Load persisted settings and open the matching backend. */
  async open(): Promise<SpaceBackend> {
    const loaded = await this.options.settings.load();
    return this.apply(loaded);
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
