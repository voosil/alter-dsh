/**
 * Server-authority backend: one thin adapter from the shared backend contract
 * to the remote bridge (link status, cache, outbox and tool ports).
 *
 * @module @alter-dsh/space/remote/backend
 */
import type { SpaceBackend } from '../core/backend.js';
import { createRemoteBridge } from './bridge.js';

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

/** Options for one remote authority backend. */
export interface RemoteBackendOptions {
  baseUrl: string;
  token: string;
  /** Local directory that owns the disposable cache/outbox database. */
  directory: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
  /** Migration-freeze gate that suspends queue replay. */
  pauseFlush?: () => boolean;
}

/**
 * Build the server-authority backend for one URL/token pair.
 * @param options - server address, token, cache directory and test seams.
 */
export function createRemoteBackend(
  options: RemoteBackendOptions,
): SpaceBackend {
  const bridge = createRemoteBridge({
    baseUrl: options.baseUrl,
    token: options.token,
    directory: options.directory,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.pauseFlush === undefined
      ? {}
      : { pauseFlush: options.pauseFlush }),
  });
  return {
    kind: 'server',
    get status() {
      return bridge.status;
    },
    rpc: (endpoint, payload, signal) => bridge.rpc(endpoint, payload, signal),
    fetchAsset: (request) => bridge.fetchAsset(request),
    document: bridge.document,
    space: bridge.space,
    assets: bridge.assets,
    queueEntries: () => bridge.queueEntries(),
    resolveQueue: (docId, action) => bridge.resolveQueue(docId, action),
    refresh: () => bridge.refresh(),
    flush: () => bridge.flush(),
    close: () => bridge.close(),
  };
}
