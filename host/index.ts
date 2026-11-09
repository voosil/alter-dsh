/**
 * Host half of the self-contained Space plugin.
 *
 * Opens the SQLite-backed Space authority, composes the business service
 * over it, and exposes it to the browser through the DSH Connection
 * RPC channel. Data lives in `${dataDir}/space.db` (default
 * `${DSH_HOME:-~/.dsh}/data/space/space.db`) and survives page and Host
 * restarts.
 *
 * @module @alter-dsh/space
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSpaceAuthority } from './authority.js';
import { createSnapshotScheduler } from './backup.js';
import { createDocumentAssetRoute } from './document/asset-route.js';
import { ASSET_ROUTE_PATH, createDocumentAssets } from './document/assets.js';
import { createDocumentService } from './document/service.js';
import {
  registerDocumentTools,
  type ToolsLike,
} from './document/tools.js';
import { withVersionRetention } from './retention.js';
import { RPC_ROUTE_PATH, createSpaceFetchRoute } from './rpc.js';
import { createSpaceStorage } from './storage.js';
import {
  createSpaceWorkspaceSync,
  isWorkspaceRegistryLike,
  type SpaceWorkspaceSync,
} from './workspace-sync.js';
import {
  openSpaceStore,
  type SpaceStoreLogger,
} from './store.js';

export const name = 'alter-dsh-space';
/** Connection provides the RPC registry; webServer is injected per channel. */
export const inject = ['connection'];

/** Plugin-row configuration; all fields optional. */
export interface SpacePluginConfig {
  /** Directory that owns `space.db`; defaults to `${DSH_HOME}/data/space`. */
  dataDir?: unknown;
  /** Set `false` to keep the Agent document tools unregistered. */
  documentTools?: unknown;
}

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

interface ConnectionLike {
  fetch: {
    register(route: {
      path: string;
      methods: string[];
      requestBody: 'buffered' | 'streaming';
      fetch: (request: Request) => Promise<Response>;
    }): () => void;
  };
}

/** Structural subset of the Cordis Host context this plugin uses. */
export interface HostContextLike {
  connection: ConnectionLike;
  logger?: LoggerLike;
  effect(execute: () => unknown, label?: string): Promise<unknown>;
  /**
   * Run `callback` on a child context that has the named services injected.
   * The callback runs once the services are available, so the Space plugin can
   * attach the workspace bridge without making the registry a hard dependency.
   */
  inject?(names: string[], callback: (child: HostContextLike) => void): unknown;
  /** Optional service read; used only when `inject` is unavailable (tests). */
  get?(name: string): unknown;
  /** Injected DSH workspace registry (present on the `inject` child). */
  workspaceRegistry?: unknown;
  /** Injected DSH tool registry (present on the `inject` child). */
  tools?: unknown;
}

function isToolsLike(value: unknown): value is ToolsLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.register === 'function';
}

/** Describe a caught error for one log line. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reconcile every Space ↔ workspace binding. The workspace registry can still
 * be starting when the bridge attaches, so a failed pass gets one delayed
 * retry; user-triggered operations reconcile on their own path as well.
 */
function reconcileWorkspaces(
  sync: SpaceWorkspaceSync,
  logger: SpaceStoreLogger,
  attempt: number,
): void {
  void sync.reconcileAll().catch((error: unknown) => {
    try {
      logger.warn?.(
        `[alter-dsh-space] 工作区对账失败（第 ${attempt} 次）：${describeError(error)}`,
      );
    } catch {
      // Diagnostics must never break activation.
    }
    if (attempt >= 2) return;
    const timer = setTimeout(
      () => reconcileWorkspaces(sync, logger, attempt + 1),
      3_000,
    );
    timer.unref?.();
  });
}

/** Resolve the data directory from config, then `DSH_HOME`, then `~/.dsh`. */
export function resolveDataDirectory(
  config: SpacePluginConfig | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const configured = config?.dataDir;
  if (typeof configured === 'string' && configured.trim() !== '')
    return resolve(configured.trim());
  const dshHome = env.DSH_HOME?.trim();
  const base = dshHome ? resolve(dshHome) : join(home, '.dsh');
  return join(base, 'data', 'space');
}

function adaptLogger(logger: unknown): SpaceStoreLogger {
  const source = logger as LoggerLike | undefined;
  const wrap = (
    method: ((message: string) => void) | undefined,
  ): ((message: string) => void) | undefined =>
    typeof method === 'function'
      ? (message: string) => {
          try {
            method.call(source, message);
          } catch {
            // Diagnostics must never break activation or writes.
          }
        }
      : undefined;
  return { info: wrap(source?.info), warn: wrap(source?.warn) };
}

/**
 * Open the authority, register the RPC channel, and close everything when the
 * plugin unloads.
 */
export async function apply(
  ctx: HostContextLike,
  config: SpacePluginConfig = {},
): Promise<void> {
  const directory = resolveDataDirectory(config, process.env, homedir());
  const now = () => new Date();
  const logger = adaptLogger(ctx.logger);
  await ctx.effect(async () => {
    const store = await openSpaceStore({ directory, now, logger });
    // The business service only sees a store that keeps version history
    // within the user's policy; the raw store keeps the persistence seams.
    const retainedStore = withVersionRetention(store, () =>
      store.getStorageSettings(),
    );
    const service = createSpaceAuthority(retainedStore, now);
    const storage = createSpaceStorage({ store, directory });
    const document = createDocumentService({ store, now });
    const assets = createDocumentAssets({ store, directory, now });
    let workspaceSync: SpaceWorkspaceSync | undefined;
    let disposeDocumentTools: (() => void) | undefined;
    const route = createSpaceFetchRoute({
      service,
      storage,
      workspaceSync: () => workspaceSync,
      document,
    });
    const attachDocumentTools = (child: HostContextLike): void => {
      const tools = child.tools ?? child.get?.('tools');
      if (!isToolsLike(tools)) {
        logger.warn?.('[alter-dsh-space] DSH 工具服务不可用：文档模型工具未注册');
        return;
      }
      const dispose = registerDocumentTools(tools, { service: document, assets });
      disposeDocumentTools = dispose;
      const cleanup = () => {
        if (disposeDocumentTools === dispose) disposeDocumentTools = undefined;
        dispose();
      };
      try {
        void child.effect(() => cleanup, 'alter-dsh-space: document tools');
      } catch {
        // A missing child effect keeps the tools registered until unload.
      }
    };
    if (config.documentTools !== false) {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (child) => attachDocumentTools(child));
      } else if (ctx.get !== undefined) {
        attachDocumentTools(ctx);
      }
    }
    const attachWorkspaceSync = (child: HostContextLike): void => {
      const registry =
        child.workspaceRegistry ?? child.get?.('workspaceRegistry');
      if (!isWorkspaceRegistryLike(registry)) {
        logger.warn?.(
          '[alter-dsh-space] DSH 工作区服务不可用：空间工作区同步未启用',
        );
        return;
      }
      const sync = createSpaceWorkspaceSync({
        registry,
        store,
        logger,
        homeDirectory: homedir(),
        now,
      });
      workspaceSync = sync;
      const dispose = () => {
        if (workspaceSync === sync) workspaceSync = undefined;
      };
      try {
        void child.effect(() => dispose, 'alter-dsh-space: workspace sync');
      } catch {
        // A missing child effect just leaves the bridge attached until unload.
      }
      reconcileWorkspaces(sync, logger, 1);
    };
    if (typeof ctx.inject === 'function') {
      ctx.inject(['workspaceRegistry'], (child) => attachWorkspaceSync(child));
    } else if (ctx.get !== undefined) {
      attachWorkspaceSync(ctx);
    }
    const disposeRoute = ctx.connection.fetch.register({
      path: RPC_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route,
    });
    const disposeAssetRoute = ctx.connection.fetch.register({
      path: ASSET_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: createDocumentAssetRoute(assets),
    });
    const snapshots = createSnapshotScheduler({
      store,
      directory,
      now,
      logger,
    });
    snapshots.start();
    logger.info?.(
      `[alter-dsh-space] 数据目录 ${directory}（${store.file}）`,
    );
    return async () => {
      workspaceSync = undefined;
      disposeDocumentTools?.();
      disposeRoute();
      disposeAssetRoute();
      await snapshots.dispose();
      await store.close();
    };
  }, 'alter-dsh-space: sqlite store + rpc');
}
