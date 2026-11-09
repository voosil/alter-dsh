/**
 * Host half of the self-contained Space plugin.
 *
 * Opens the SQLite-backed Space authority, composes the vendored business
 * service over it, and exposes it to the browser through the DSH Connection
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
import { withVersionRetention } from './retention.js';
import { RPC_ROUTE_PATH, createSpaceFetchRoute } from './rpc.js';
import { createSpaceStorage } from './storage.js';
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
   * The Connection RPC registry needs a context that can read `webServer`.
   */
  inject(names: string[], callback: (child: HostContextLike) => void): unknown;
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
    const route = createSpaceFetchRoute({ service, storage });
    const disposeRoute = ctx.connection.fetch.register({
      path: RPC_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route,
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
      disposeRoute();
      await snapshots.dispose();
      await store.close();
    };
  }, 'alter-dsh-space: sqlite store + rpc');
}
