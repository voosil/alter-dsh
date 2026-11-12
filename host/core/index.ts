/**
 * Host half of the self-contained Space plugin.
 *
 * Registers the RPC/asset routes and the Agent document tools once, then routes
 * every business call through the mode controller: the local SQLite authority
 * by default, or a self-hosted Space server when the user configures one.
 * Settings/sync endpoints stay local so the panel can recover a broken link.
 *
 * @module @alter-dsh/space
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ASSET_ROUTE_PATH } from '../document/asset-store.js';
import {
  registerDocumentTools,
  type DocumentToolApi,
  type DocumentToolAssetApi,
  type ToolsLike,
} from '../document/editors/legacy/tools.js';
import { registerSpaceDomainTools } from '../authority/domain-tools.js';
import { registerSpaceTools } from '../authority/space-tools.js';
import type { RpcCall } from '../authority/tool-support.js';
import {
  createConnectionSettingsStore,
  type CredentialStoreLike,
} from '../control/connection-settings.js';
import { createConnectionAudit } from '../control/connection-audit.js';
import {
  registerAgentSettingsTool,
  type ApprovalLike,
} from '../control/agent-settings-tool.js';
import { registerAgentMigrationTool } from '../control/agent-migration-tool.js';
import type { SpaceBackend, SpaceToolApi } from './backend.js';
import { SpaceModeController } from './mode.js';
import { createSettingsRpcHandler } from '../control/settings-rpc.js';
import {
  createMigrationService,
} from '../control/migration/service.js';
import { createMigrationRpcHandler } from '../control/migration/rpc.js';
import { sweepMigrationStaging } from '../control/migration/staging.js';
import { isReadEndpoint } from '../authority/endpoints.js';
import {
  RPC_ROUTE_PATH,
  createConnectionFetchRoute,
  type SpaceRpcHandler,
} from '../authority/rpc.js';
import type { SpaceStoreLogger } from '../persistence/store.js';
import {
  createSpaceWorkspaceSync,
  isWorkspaceRegistryLike,
  type SpaceWorkspaceSync,
} from '../workspace/sync.js';

export const name = 'alter-dsh-space';
/** Connection provides the RPC registry; webServer is injected per channel. */
export const inject = ['connection'];

/** Plugin-row configuration; all fields optional. */
export interface SpacePluginConfig {
  /** Directory that owns `space.db`; defaults to `${DSH_HOME}/data/space`. */
  dataDir?: unknown;
  /** Set `false` to keep the Agent document tools unregistered. */
  documentTools?: unknown;
  /** Set `false` to keep the Agent space structure tools unregistered. */
  spaceTools?: unknown;
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
  /** Injected DSH approval service (present on the `inject` child). */
  approval?: unknown;
}

function isToolsLike(value: unknown): value is ToolsLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.register === 'function';
}

function isApprovalLike(value: unknown): value is ApprovalLike {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { request?: unknown }).request === 'function';
}

function isCredentialStoreLike(value: unknown): value is CredentialStoreLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.readRecord === 'function' &&
    typeof candidate.modifyRecord === 'function' &&
    typeof candidate.deleteRecord === 'function'
  );
}

/** Resolve the optional DSH credentials service without a hard dependency. */
function credentialsOf(ctx: HostContextLike): CredentialStoreLike | undefined {
  try {
    const direct = (ctx as { credentials?: unknown }).credentials;
    if (isCredentialStoreLike(direct)) return direct;
  } catch {
    // Cordis throws on service access that was not declared in `inject`.
  }
  if (ctx.get === undefined) return undefined;
  try {
    const value = ctx.get('credentials');
    return isCredentialStoreLike(value) ? value : undefined;
  } catch {
    // Optional service lookups may throw while the service is unregistered.
    return undefined;
  }
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

/** Live proxy so Agent tools always call the active authority backend. */
function createDocumentProxy(
  source: () => DocumentToolApi,
  isLocked: () => boolean,
): DocumentToolApi {
  const guard = (): void => {
    if (isLocked())
      throw new Error('迁移进行中，文档暂时只读；请等待迁移完成');
  };
  return {
    outline: (docId) => source().outline(docId),
    read: (docId, options) => source().read(docId, options),
    search: (input) => source().search(input),
    applyOperations: (input) => {
      guard();
      return source().applyOperations(input);
    },
    generate: (input) => {
      guard();
      return source().generate(input);
    },
    undo: (input) => {
      guard();
      return source().undo(input);
    },
    getObject: (objectId) => source().getObject(objectId),
    updateObject: (input) => {
      guard();
      return source().updateObject(input);
    },
  };
}

/**
 * Live proxy so Agent space tools always call the active authority backend.
 * Reads stay available during a migration freeze; structure writes refuse
 * with the stable `migration/read-only` code (same shape as the document
 * proxy, whose guard the tools surface as a code-carrying error).
 */
export function createSpaceProxy(
  source: () => SpaceToolApi,
  isLocked: () => boolean,
): SpaceToolApi {
  const guard = (): void => {
    if (isLocked())
      throw Object.assign(
        new Error('迁移进行中，空间结构暂时只读；请等待迁移完成'),
        { code: 'migration/read-only' },
      );
  };
  return {
    listSpaces: () => source().listSpaces(),
    getSpace: (id) => source().getSpace(id),
    listArchivedSpaces: () => source().listArchivedSpaces(),
    listNodes: (spaceId) => source().listNodes(spaceId),
    getNode: (id) => source().getNode(id),
    search: (spaceId, query) => source().search(spaceId, query),
    getOverview: (spaceId) => source().getOverview(spaceId),
    listDeleted: (spaceId) => source().listDeleted(spaceId),
    createNode: (input) => {
      guard();
      return source().createNode(input);
    },
    saveNode: (id, patch) => {
      guard();
      return source().saveNode(id, patch);
    },
    moveNode: (id, target) => {
      guard();
      return source().moveNode(id, target);
    },
    setPinned: (id, pinned) => {
      guard();
      return source().setPinned(id, pinned);
    },
    setArchived: (id, archived) => {
      guard();
      return source().setArchived(id, archived);
    },
    deleteNode: (id) => {
      guard();
      return source().deleteNode(id);
    },
    restoreNode: (id) => {
      guard();
      return source().restoreNode(id);
    },
  };
}

/** Admission barrier that drains in-flight writes around a migration freeze. */
export interface SpaceRpcGate {
  /** Admit one call, or refuse it because a migration froze the authority. */
  admitCall(mutating: boolean): (() => void) | undefined;
  /** Resolve once every admitted call has released. */
  awaitDrain(): Promise<void>;
}

/**
 * Build the in-flight/drain barrier used while a migration snapshots the
 * authority.
 *
 * The lock check and the in-flight increment share one synchronous block on
 * purpose: a call that observes an unlocked mode is counted before any freeze
 * can start draining, so `awaitDrain` never misses a write that is about to
 * run.
 *
 * @param isLocked - whether a migration currently freezes mutating calls.
 */
export function createSpaceRpcGate(isLocked: () => boolean): SpaceRpcGate {
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();
  return {
    admitCall(mutating) {
      if (mutating && isLocked()) return undefined;
      inFlight += 1;
      return () => {
        inFlight -= 1;
        if (inFlight !== 0) return;
        for (const resolve of [...drainWaiters]) {
          drainWaiters.delete(resolve);
          resolve();
        }
      };
    },
    awaitDrain() {
      return new Promise<void>((resolve) => {
        if (inFlight === 0) resolve();
        else drainWaiters.add(resolve);
      });
    },
  };
}

/**
 * Which plugin-owned handler serves an endpoint, if any.
 *
 * Prefix-based on purpose: unknown `settings.*` / `sync.*` / `migration.*`
 * methods belong to the control plane too, so they fail with their own
 * `settings/not-found` / migration error instead of being judged as business
 * (write) endpoints and frozen or forwarded to a backend.
 */
export function controlPlaneOf(
  endpoint: string,
): 'migration' | 'settings' | undefined {
  const group = endpoint.split('.')[0];
  if (group === 'migration') return 'migration';
  if (group === 'settings' || group === 'sync') return 'settings';
  return undefined;
}

/** Dependencies for the plugin RPC dispatch. */
export interface SpaceRpcDispatchOptions {
  gate: SpaceRpcGate;
  settingsHandler: SpaceRpcHandler;
  migrationHandler: SpaceRpcHandler;
  /** Active authority backend; resolved per call so mode switches apply live. */
  backend: () => Pick<SpaceBackend, 'rpc'>;
}

/**
 * Route one RPC call: control-plane endpoints always reach their own handler
 * (they must work while the server is offline and while a migration freezes
 * the authority), business reads stay available, and only mutating business
 * calls are refused during a migration.
 */
export function createSpaceRpcDispatch(
  options: SpaceRpcDispatchOptions,
): SpaceRpcHandler {
  return async (endpoint, payload, signal) => {
    const control = controlPlaneOf(endpoint);
    const release = options.gate.admitCall(
      control === undefined && !isReadEndpoint(endpoint),
    );
    if (release === undefined)
      return {
        error: {
          code: 'migration/read-only',
          message: '迁移进行中，空间暂时只读；请等待迁移完成',
        },
      };
    try {
      if (control === 'migration')
        return options.migrationHandler(endpoint, payload, signal, undefined);
      if (control === 'settings')
        return options.settingsHandler(endpoint, payload, signal, undefined);
      return await options.backend().rpc(endpoint, payload, signal);
    } finally {
      release();
    }
  };
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
    const settings = createConnectionSettingsStore({
      directory,
      now,
      logger,
      ...(credentialsOf(ctx) === undefined
        ? {}
        : { credentials: credentialsOf(ctx) as CredentialStoreLike }),
    });
    let workspaceSync: SpaceWorkspaceSync | undefined;
    const mode = new SpaceModeController({
      directory,
      settings,
      now,
      logger,
      workspaceSync: () => workspaceSync,
    });
    const audit = createConnectionAudit(directory);
    await mode.open();
    // A crashed or cancelled transfer leaves staging/backups under
    // `<dataDir>/.migration/`; keeping the manual-recovery window clean must
    // never block startup, so this is fire-and-forget.
    void sweepMigrationStaging(directory).catch(() => undefined);
    const degraded = mode.degraded();
    if (degraded !== undefined) {
      // Configuration errors fall back to local (recorded for the user);
      // transient failures keep server mode and simply report offline.
      audit.record({
        actor: 'user',
        action: 'mode',
        to: degraded.transient ? 'server' : 'local',
        result: 'failed',
      });
    }
    // Freezing for a migration snapshot must wait for writes that already
    // passed the lock check; otherwise an acked write could commit after the
    // snapshot and be lost on the target authority. The gate owns both the
    // lock check and the in-flight accounting, and it deliberately admits the
    // control plane (settings/sync/migration) even while frozen.
    const gate = createSpaceRpcGate(() => mode.isMigrationLocked());

    const migration = createMigrationService({
      directory,
      settings,
      mode,
      now,
      logger,
      awaitDrain: () => gate.awaitDrain(),
    });
    const settingsHandler = createSettingsRpcHandler({
      settings,
      mode,
      audit,
      directory,
      isMigrationRunning: () => migration.status().status === 'running',
    });
    const migrationHandler = createMigrationRpcHandler(migration);
    let approvalRef: ApprovalLike | undefined;
    if (typeof ctx.inject === 'function') {
      ctx.inject(['approval'], (child) => {
        const candidate = child.approval ?? child.get?.('approval');
        if (isApprovalLike(candidate)) approvalRef = candidate;
      });
    }
    const documentProxy = createDocumentProxy(
      () => mode.current().document,
      () => mode.isMigrationLocked(),
    );
    const spaceProxy = createSpaceProxy(
      () => mode.current().space,
      () => mode.isMigrationLocked(),
    );
    // Domain tools name an endpoint; this seam keeps the alter identity and the
    // migration freeze in one place (reads stay allowed while frozen).
    const toolRpc: RpcCall = async (endpoint, args) => {
      if (!isReadEndpoint(endpoint) && mode.isMigrationLocked())
        throw Object.assign(
          new Error('迁移进行中，空间暂时只读；请等待迁移完成'),
          { code: 'migration/read-only' },
        );
      return mode.current().agentRpc(endpoint, args);
    };
    const assetsProxy: DocumentToolAssetApi = {
      import: (input) => {
        if (mode.isMigrationLocked())
          throw new Error('迁移进行中，文档暂时只读；请等待迁移完成');
        return mode.current().assets.import(input);
      },
    };
    let disposeDocumentTools: (() => void) | undefined;
    let disposeSpaceTools: (() => void) | undefined;
    let disposeDomainTools: (() => void) | undefined;
    let disposeSettingsTool: (() => void) | undefined;
    const attachSettingsTool = (child: HostContextLike): void => {
      const tools = child.tools ?? child.get?.('tools');
      if (!isToolsLike(tools)) return;
      const disposeSettings = registerAgentSettingsTool(tools, {
        settings,
        mode,
        directory,
        audit,
        approval: () => approvalRef,
      });
      const disposeMigration = registerAgentMigrationTool(tools, {
        migration,
        audit,
        approval: () => approvalRef,
      });
      const dispose = () => {
        disposeSettings();
        disposeMigration();
      };
      disposeSettingsTool = dispose;
      try {
        // The effect callback runs immediately and its RETURN value is the
        // teardown: registering must not dispose the tools it just created.
        void child.effect(() => {
          const cleanup = () => {
            if (disposeSettingsTool === dispose) disposeSettingsTool = undefined;
            dispose();
          };
          return cleanup;
        }, 'alter-dsh-space: server settings tool');
      } catch {
        // Keep the registration until unload when the child cannot own it.
      }
    };
    const attachDocumentTools = (child: HostContextLike): void => {
      const tools = child.tools ?? child.get?.('tools');
      if (!isToolsLike(tools)) {
        logger.warn?.(
          '[alter-dsh-space] DSH 工具服务不可用：文档模型工具未注册',
        );
        return;
      }
      const dispose = registerDocumentTools(tools, {
        service: documentProxy,
        assets: assetsProxy,
      });
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
    const attachSpaceTools = (child: HostContextLike): void => {
      const tools = child.tools ?? child.get?.('tools');
      if (!isToolsLike(tools)) {
        logger.warn?.(
          '[alter-dsh-space] DSH 工具服务不可用：空间结构工具未注册',
        );
        return;
      }
      const dispose = registerSpaceTools(tools, { service: spaceProxy });
      disposeSpaceTools = dispose;
      const cleanup = () => {
        if (disposeSpaceTools === dispose) disposeSpaceTools = undefined;
        dispose();
      };
      try {
        void child.effect(() => cleanup, 'alter-dsh-space: space tools');
      } catch {
        // A missing child effect keeps the tools registered until unload.
      }
    };
    const attachDomainTools = (child: HostContextLike): void => {
      const tools = child.tools ?? child.get?.('tools');
      if (!isToolsLike(tools)) {
        logger.warn?.(
          '[alter-dsh-space] DSH 工具服务不可用：空间领域工具未注册',
        );
        return;
      }
      const dispose = registerSpaceDomainTools(tools, {
        rpc: toolRpc,
        approval: () => approvalRef,
      });
      disposeDomainTools = dispose;
      const cleanup = () => {
        if (disposeDomainTools === dispose) disposeDomainTools = undefined;
        dispose();
      };
      try {
        void child.effect(() => cleanup, 'alter-dsh-space: space domain tools');
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
    if (config.spaceTools !== false) {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (child) => attachSpaceTools(child));
      } else if (ctx.get !== undefined) {
        attachSpaceTools(ctx);
      }
    }
    if (config.spaceTools !== false) {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (child) => attachDomainTools(child));
      } else if (ctx.get !== undefined) {
        attachDomainTools(ctx);
      }
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (child) => attachSettingsTool(child));
    } else if (ctx.get !== undefined) {
      attachSettingsTool(ctx);
    }
    let registry: unknown;
    let detachWorkspaceSync: (() => void) | undefined;
    const applyWorkspaceBridge = (backend: SpaceBackend): void => {
      detachWorkspaceSync?.();
      detachWorkspaceSync = undefined;
      workspaceSync = undefined;
      if (backend.kind !== 'local' || backend.local === undefined) return;
      if (!isWorkspaceRegistryLike(registry)) return;
      const sync = createSpaceWorkspaceSync({
        registry,
        store: backend.local.store,
        logger,
        homeDirectory: homedir(),
        now,
      });
      workspaceSync = sync;
      detachWorkspaceSync = () => {
        if (workspaceSync === sync) workspaceSync = undefined;
      };
      reconcileWorkspaces(sync, logger, 1);
    };
    const unsubscribeWorkspace = mode.onChange((backend) => {
      applyWorkspaceBridge(backend);
    });
    const attachWorkspaceRegistry = (child: HostContextLike): void => {
      registry = child.workspaceRegistry ?? child.get?.('workspaceRegistry');
      if (!isWorkspaceRegistryLike(registry)) {
        logger.warn?.(
          '[alter-dsh-space] DSH 工作区服务不可用：空间工作区同步未启用',
        );
        return;
      }
      applyWorkspaceBridge(mode.current());
    };
    if (typeof ctx.inject === 'function') {
      ctx.inject(['workspaceRegistry'], (child) =>
        attachWorkspaceRegistry(child),
      );
    } else if (ctx.get !== undefined) {
      attachWorkspaceRegistry(ctx);
    }
    const route = createConnectionFetchRoute(
      createSpaceRpcDispatch({
        gate,
        settingsHandler,
        migrationHandler,
        backend: () => mode.current(),
      }),
    );
    const assetRoute = (request: Request) =>
      mode.current().fetchAsset(request);
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
      fetch: assetRoute,
    });
    logger.info?.(
      `[alter-dsh-space] 本地数据目录 ${directory}；当前 ${mode.status().state === 'local' ? '本地模式' : '服务端模式'}`,
    );
    return async () => {
      migration.cancel();
      unsubscribeWorkspace();
      detachWorkspaceSync?.();
      workspaceSync = undefined;
      disposeDocumentTools?.();
      disposeSpaceTools?.();
      disposeSettingsTool?.();
      disposeRoute();
      disposeAssetRoute();
      await mode.close();
    };
  }, 'alter-dsh-space: authority + rpc');
}
