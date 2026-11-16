#!/usr/bin/env node
/**
 * Entry point for the standalone Space server.
 *
 * Intended deployment is one Docker container with a mounted data volume and
 * `SPACE_TOKENS` supplied by the environment. The process owns the SQLite
 * authority directly; it does not need DSH, a browser or an agent runtime.
 *
 * @module @alter-dsh/space/space
 */
import { accessSync, constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalSpaceRuntime } from '../../host/core/runtime.js';
import { createTokenAuthenticator } from './auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createSpaceHttpServer } from './http.js';
import { createServerMigration, type ServerMigration } from '../migration/service.js';

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

/** One running server instance. */
export interface RunningSpaceServer {
  readonly config: ServerConfig;
  /** Base URL the listener is reachable at, e.g. `http://127.0.0.1:8787`. */
  readonly url: string;
  /** Stop the listener and close the database owned by the runtime. */
  close(): Promise<void>;
}

function defaultLogger(): LoggerLike {
  return {
    info: (message: string) => console.log(`[space-server] ${message}`),
    warn: (message: string) => console.error(`[space-server] ${message}`),
  };
}

/** Whether the listener is bound to a loopback authority. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Whether the listener is bound to every interface. */
function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

/**
 * Build the URL a human should open.
 *
 * `0.0.0.0` is a bind address, not a destination; logging
 * `http://0.0.0.0:8787` produces a link most tools cannot open, so display the
 * loopback address for a wildcard bind instead.
 */
function displayUrl(host: string, port: number): string {
  if (isWildcardHost(host)) return `http://127.0.0.1:${String(port)}`;
  if (host === '::1') return `http://[::1]:${String(port)}`;
  return `http://${host}:${String(port)}`;
}

/**
 * Whether the process may write into its data directory.
 *
 * The runtime opened (and created) the directory before this probe runs, so a
 * negative answer means a broken mount or permission set, not a missing path.
 * A failed probe is a diagnostic, not a startup error: `/healthz` reports it.
 */
function isDataDirWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the authority and start the HTTP listener.
 * @param config - parsed server configuration.
 * @param logger - optional log sink (tests stay quiet).
 */
export async function startSpaceServer(
  config: ServerConfig,
  logger: LoggerLike = defaultLogger(),
): Promise<RunningSpaceServer> {
  let runtime = await createLocalSpaceRuntime({
    directory: config.dataDir,
    logger,
    snapshots: config.snapshots,
  });
  const dataDirWritable = isDataDirWritable(config.dataDir);
  const auth = createTokenAuthenticator(config.tokens);
  let migration: ServerMigration | undefined;
  const http = createSpaceHttpServer({
    runtime,
    auth,
    logger,
    diagnostics: {
      dataDirWritable,
      snapshots: config.snapshots,
    },
    migration: () => migration,
    // While the migration handler replaces the data directory it pauses the
    // runtime; business routes answer a stable 503 instead of touching the
    // closed database.
    frozen: () => migration?.paused() === true,
  });
  try {
    const port = await http.listen(config.host, config.port);
    migration = createServerMigration({
      dataDir: config.dataDir,
      logger,
      forceInitialSnapshot: config.snapshots,
      current: () => runtime,
      async pause() {
        await runtime.close();
      },
      async resume() {
        runtime = await createLocalSpaceRuntime({
          directory: config.dataDir,
          logger,
          snapshots: config.snapshots,
        });
        http.replaceRuntime(runtime);
        return runtime;
      },
    });
    const url = displayUrl(config.host, port);
    logger.info?.(`数据目录 ${config.dataDir}；监听 ${config.host}:${String(port)}`);
    logger.info?.(`服务地址 ${url}；token ${auth.labels.join(', ')}`);
    logger.info?.(
      isWildcardHost(config.host)
        ? `客户端在 DSH「设置 → 服务器」填写宿主机或反向代理地址；同机可先用 ${url}（容器内监听地址不是客户端地址）`
        : `客户端在 DSH「设置 → 服务器」填写 ${url}；容器内监听地址不是客户端地址`,
    );
    if (!isLoopbackHost(config.host)) {
      logger.warn?.(
        '监听地址不是 loopback：请只在私网使用，或用 TLS 反向代理暴露；服务端不提供 TLS 终止',
      );
    }
    let closing: Promise<void> | undefined;
    return {
      config,
      url,
      close() {
        closing ??= (async () => {
          // `close` stops accepting new commits and waits for the in-flight
          // one, so SIGTERM cannot kill a half-replaced data directory.
          await migration?.close();
          await http.close();
          await runtime.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

/** Load the environment and start the server, installing signal handlers. */
export async function runSpaceServer(
  env: NodeJS.ProcessEnv = process.env,
  logger: LoggerLike = defaultLogger(),
): Promise<RunningSpaceServer> {
  const config = loadServerConfig(env);
  const running = await startSpaceServer(config, logger);
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info?.(`收到 ${signal}，正在关闭`);
    void running
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.warn?.(
          `关闭失败：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  return running;
}

/**
 * Whether this module is the process entry point.
 *
 * Package bins are often symlinked (pnpm, npm, Docker wrappers); comparing the
 * literal `argv[1]` string against `import.meta.url` fails for a symlink and
 * the process would silently exit 0 without starting. Resolve both sides to
 * their real paths instead.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runSpaceServer().catch((error: unknown) => {
    console.error(
      `[space-server] 启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}