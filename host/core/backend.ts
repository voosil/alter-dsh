/**
 * Authority backends: the plugin routes every Space RPC through whichever
 * backend is active, so switching between the local SQLite authority and a
 * self-hosted server never touches the browser protocol.
 *
 * @module @alter-dsh/space/core/backend
 */
import type { SpaceService } from '@alter/protocol';
import type { DocumentToolApi, DocumentToolAssetApi } from '../document/editors/legacy/tools.js';
import { createDocumentAssetRoute } from '../document/asset-route.js';
import type { SyncQueueEntry } from '../remote/bridge.js';
import type { SpaceStoreHandle } from '../persistence/store.js';
import { createSpaceRpc } from '../authority/rpc.js';
import type { LocalSpaceRuntime } from './runtime.js';
import type { SpaceWorkspaceSync } from '../workspace/sync.js';

/** Connection facts shown in the settings page and Agent tool results. */
export interface BackendConnectionStatus {
  /** `local` in local mode; server modes report the link state. */
  state: 'local' | 'connecting' | 'online' | 'offline' | 'error';
  /** Human-readable detail for offline/error states. */
  message?: string;
  /** Server package version, once known. */
  serverVersion?: string;
  /** Server wire protocol version, once known. */
  protocolVersion?: number;
  /** Local durable writes waiting for the server. */
  pendingWrites?: number;
  /** Documents whose queued write cannot be replayed without a decision. */
  conflicts?: number;
  /** Queued writes rejected by the server and awaiting a user decision. */
  failed?: number;
  /** ISO instant of the last successful sync. */
  lastSyncedAt?: string;
}

/**
 * One authority implementation. The route layer, Agent tools and workspace
 * bridge only see this interface.
 */
export interface SpaceBackend {
  readonly kind: 'local' | 'server';
  /** Current link/authority facts. */
  readonly status: BackendConnectionStatus;
  /** Dispatch one business endpoint; returns `{ value }` or `{ error }`. */
  rpc(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Serve one asset GET request (already authenticated by the local Host). */
  fetchAsset(request: Request): Promise<Response>;
  /** Agent tool surface over the document model. */
  readonly document: DocumentToolApi;
  /** Agent tool surface for importing assets. */
  readonly assets: DocumentToolAssetApi;
  /** Present only while the local authority owns the data. */
  readonly local?: {
    readonly store: SpaceStoreHandle;
    readonly service: SpaceService;
  };
  /** Documents with unsettled queued writes; empty or absent locally. */
  queueEntries?(): SyncQueueEntry[];
  /** Retry or discard one document's unsettled writes (server mode only). */
  resolveQueue?(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<{ resolved: number }>;
  /** Re-probe a remote link; local backends resolve immediately. */
  refresh?(): Promise<void>;
  /** Flush queued writes; local backends resolve immediately. */
  flush?(): Promise<void>;
  close(): Promise<void>;
}

/** Options for the local authority backend. */
export interface LocalBackendOptions {
  runtime: LocalSpaceRuntime;
  /** Resolver for the optional workspace bridge state, live across swaps. */
  workspaceSync?: () => SpaceWorkspaceSync | undefined;
}

/**
 * Wrap one opened local runtime as a backend.
 * @param options - runtime and the live workspace-bridge resolver.
 */
export function createLocalBackend(
  options: LocalBackendOptions,
): SpaceBackend {
  const { runtime } = options;
  const handler = createSpaceRpc({
    service: runtime.service,
    storage: runtime.storage,
    document: runtime.document,
    assets: runtime.assets,
    workspaceSync: options.workspaceSync ?? (() => undefined),
  });
  const assetRoute = createDocumentAssetRoute(runtime.assets);
  let closed = false;
  return {
    kind: 'local',
    status: { state: 'local' },
    rpc: (endpoint, payload, signal) =>
      handler(endpoint, payload, signal ?? new AbortController().signal, undefined),
    fetchAsset: (request) => assetRoute(request),
    document: runtime.document,
    assets: runtime.assets,
    local: { store: runtime.store, service: runtime.service },
    async close() {
      if (closed) return;
      closed = true;
      await runtime.close();
    },
  };
}
