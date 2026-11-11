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
import { pathToFileURL } from 'node:url';
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
  const auth = createTokenAuthenticator(config.tokens);
  let migration: ServerMigration | undefined;
  const http = createSpaceHttpServer({
    runtime,
    auth,
    logger,
    migration: () => migration,
  });
  try {
    const port = await http.listen(config.host, config.port);
    migration = createServerMigration({
      dataDir: config.dataDir,
      logger,
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
    const url = `http://${config.host}:${String(port)}`;
    logger.info?.(
      `数据目录 ${config.dataDir}；监听 ${url}；token ${auth.labels.join(', ')}`,
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
          await http.close();
          await migration?.close();
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

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(entry).href
) {
  runSpaceServer().catch((error: unknown) => {
    console.error(
      `[space-server] 启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
