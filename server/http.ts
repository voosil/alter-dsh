/**
 * Standalone HTTP carrier for the Space server.
 *
 * The plugin talks to this server through a local Host bridge; browsers never
 * reach it directly. It exposes the same RPC and asset routes the plugin
 * serves locally, authenticated by bearer tokens, plus `/healthz`, `/version`
 * and the migration endpoints used to replace the data directory while the
 * runtime is paused.
 *
 * @module @alter-dsh/space/server/http
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDocumentAssetRoute } from '../host/document/asset-route.js';
import { ASSET_ROUTE_PATH } from '../host/document/assets.js';
import { spaceServerInfo, type SpaceServerInfo } from '../host/protocol.js';
import { RPC_ROUTE_PATH, createSpaceFetchRoute } from '../host/rpc.js';
import type { LocalSpaceRuntime } from '../host/runtime.js';
import { SPACE_DB_FORMAT_VERSION } from '../host/store.js';
import type { TokenAuthenticator } from './auth.js';
import {
  MIGRATION_PATH,
  type ServerMigration,
} from './migration.js';

/** Default body bound for one RPC request. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Migration parts may be larger than ordinary RPC calls. */
export const MAX_MIGRATION_BODY_BYTES = 64 * 1024 * 1024;

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

/** Options for one standalone Space HTTP server. */
export interface SpaceHttpServerOptions {
  runtime: LocalSpaceRuntime;
  auth: TokenAuthenticator;
  /** Resolves the migration handler once the server lifecycle created it. */
  migration?: () => ServerMigration | undefined;
  maxRequestBodyBytes?: number;
  logger?: LoggerLike;
}

/** Handle returned by {@link createSpaceHttpServer}. */
export interface SpaceHttpServer {
  readonly server: Server;
  /** Listen and resolve the bound port (0 asks the OS). */
  listen(host: string, port: number): Promise<number>;
  /** Swap the runtime whose routes this carrier dispatches after reopening. */
  replaceRuntime(runtime: LocalSpaceRuntime): void;
  close(): Promise<void>;
}

interface BodyReadResult {
  body: Buffer;
  tooLarge: boolean;
}

function jsonResponse(
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function headerRecord(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      request.resume();
      return { body: Buffer.alloc(0), tooLarge: true };
    }
    chunks.push(buffer);
  }
  return { body: Buffer.concat(chunks), tooLarge: false };
}

async function writeResponse(
  response: ServerResponse,
  result: Response,
): Promise<void> {
  const body = Buffer.from(await result.arrayBuffer());
  response.statusCode = result.status;
  for (const [name, value] of result.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    response.setHeader(name, value);
  }
  response.setHeader('content-length', String(body.byteLength));
  response.end(body);
}

/**
 * Create the standalone HTTP carrier for one opened runtime.
 * @param options - runtime, token verifier, body bound, migration and logger.
 */
export function createSpaceHttpServer(
  options: SpaceHttpServerOptions,
): SpaceHttpServer {
  const { auth } = options;
  const limit = options.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const logger = options.logger ?? {};
  const info: SpaceServerInfo = spaceServerInfo(SPACE_DB_FORMAT_VERSION);
  let activeRuntime = options.runtime;
  let rpcRoute = buildRpcRoute(activeRuntime);
  let assetRoute = buildAssetRoute(activeRuntime);

  function buildRpcRoute(runtime: LocalSpaceRuntime) {
    return createSpaceFetchRoute({
      service: runtime.service,
      storage: runtime.storage,
      document: runtime.document,
      assets: runtime.assets,
      workspaceSync: () => undefined,
      // The bridge speaks for a user browser or an Agent tool; honor its
      // explicit `alter` so version attribution survives the hop.
      actorPolicy: 'passthrough',
    });
  }

  function buildAssetRoute(runtime: LocalSpaceRuntime) {
    return createDocumentAssetRoute(runtime.assets);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.warn?.(
        `[space-server] 请求处理失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (response.headersSent) {
        response.destroy();
        return;
      }
      void writeResponse(response, jsonResponse(500, { error: 'server_error' }));
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://space.internal');
    const path = url.pathname;

    if (path === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        await writeResponse(
          response,
          jsonResponse(405, { error: 'method_not_allowed' }),
        );
        return;
      }
      await writeResponse(
        response,
        jsonResponse(200, {
          ok: true,
          ...info,
        }),
      );
      return;
    }
    if (path === '/version') {
      if (request.method !== 'GET') {
        await writeResponse(
          response,
          jsonResponse(405, { error: 'method_not_allowed' }),
        );
        return;
      }
      await writeResponse(response, jsonResponse(200, info));
      return;
    }

    const isRpc = path === RPC_ROUTE_PATH;
    const isAsset = path === ASSET_ROUTE_PATH;
    const isMigration = path.startsWith(MIGRATION_PATH);
    if (!isRpc && !isAsset && !isMigration) {
      await writeResponse(response, jsonResponse(404, { error: 'not_found' }));
      return;
    }
    if (!auth.authorize(request.headers.authorization)) {
      await writeResponse(
        response,
        jsonResponse(
          401,
          { error: 'unauthorized' },
          { 'www-authenticate': 'Bearer' },
        ),
      );
      return;
    }
    if (isRpc && request.method !== 'POST') {
      await writeResponse(
        response,
        jsonResponse(405, { error: 'method_not_allowed' }),
      );
      return;
    }
    if (isAsset && request.method !== 'GET') {
      await writeResponse(
        response,
        jsonResponse(405, { error: 'method_not_allowed' }),
      );
      return;
    }
    const bodyLimit = isMigration ? MAX_MIGRATION_BODY_BYTES : limit;
    const needsBody =
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      (isRpc || isMigration);
    const body = needsBody
      ? await readBody(request, bodyLimit)
      : { body: Buffer.alloc(0), tooLarge: false };
    if (body.tooLarge) {
      await writeResponse(
        response,
        jsonResponse(413, { error: 'payload_too_large' }),
      );
      return;
    }
    const forwarded = new Request(
      `http://space.internal${path}${url.search}`,
      {
        method: request.method,
        headers: headerRecord(request),
        ...(needsBody ? { body: body.body } : {}),
      },
    );
    if (isMigration) {
      const migration = options.migration?.();
      const result =
        migration === undefined
          ? jsonResponse(404, { error: 'migration_unavailable' })
          : await migration.handle(forwarded, url);
      if (result !== undefined) {
        await writeResponse(response, result);
        return;
      }
    }
    const result = isRpc
      ? await rpcRoute(forwarded)
      : await assetRoute(forwarded);
    await writeResponse(response, result);
  }

  return {
    server,
    listen(host: string, port: number): Promise<number> {
      return new Promise((resolvePort, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address() as AddressInfo | null;
          resolvePort(address?.port ?? port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    replaceRuntime(runtime: LocalSpaceRuntime): void {
      activeRuntime = runtime;
      rpcRoute = buildRpcRoute(runtime);
      assetRoute = buildAssetRoute(runtime);
    },
    close(): Promise<void> {
      return new Promise((resolveClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}
