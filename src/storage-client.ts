/**
 * Browser client for the Host's storage settings API.
 *
 * Separate from `space-client.ts` on purpose: `SpaceService` is the
 * product contract (space/content/hub), while storage policy is a DSH-port
 * extension used only by the settings page. Both ride the same Connection RPC
 * channel and envelope.
 *
 * Types mirror `host/storage.ts`; keep the field names in sync.
 */
import {
  SPACE_RPC_CHANNEL,
  SPACE_RPC_ENDPOINT,
  type SpaceRpcCaller,
} from './space-client.js';

/** User-tunable storage policy (Host defaults: 10 versions / 3 snapshots). */
export interface StorageSettings {
  /** Maximum number of document versions kept per document. */
  historyLimit: number;
  /** Maximum number of daily whole-database snapshots kept on disk. */
  snapshotKeep: number;
}

/** Optional addressable fields when reading or saving the policy. */
export type StorageSettingsPatch = Partial<StorageSettings>;

/** Disk-footprint estimate returned by the Host. */
export interface StorageEstimate {
  documentCount: number;
  averageDocumentBytes: number;
  currentBytes: number;
  currentMainBytes: number;
  currentSnapshotBytes: number;
  currentWalBytes: number;
  projectedBytes: number;
  projectedMainBytes: number;
  projectedSnapshotBytes: number;
  deltaBytes: number;
}

/** Settings plus the estimate for those settings. */
export interface StorageState {
  settings: StorageSettings;
  estimate: StorageEstimate;
}

/** Browser-side storage API used by the settings section. */
export interface SpaceStorageClient {
  get(): Promise<StorageState>;
  estimate(patch?: StorageSettingsPatch): Promise<StorageEstimate>;
  set(patch: StorageSettingsPatch): Promise<StorageState>;
}

/** Failure raised by the Host storage endpoints. */
export class StorageRemoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StorageRemoteError';
    this.code = code;
  }
}

function remoteError(error: unknown): StorageRemoteError {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message =
      typeof record.message === 'string' ? record.message : '存储设置操作失败';
    const code = typeof record.code === 'string' ? record.code : 'space/failed';
    return new StorageRemoteError(code, message);
  }
  return new StorageRemoteError('space/failed', '存储设置操作失败');
}

/**
 * Build the browser-side storage client.
 * @param rpc - the client Connection RPC caller.
 */
export function createSpaceStorageClient(
  rpc: SpaceRpcCaller,
): SpaceStorageClient {
  async function call<T>(op: string, args: unknown[] = []): Promise<T> {
    const result = await rpc.call(SPACE_RPC_CHANNEL, SPACE_RPC_ENDPOINT, {
      op,
      args,
    });
    if (!result.ok) throw remoteError(result.error);
    const body = result.value;
    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      if (record.error !== undefined) throw remoteError(record.error);
      return (record.value ?? undefined) as T;
    }
    return undefined as T;
  }

  return {
    get: () => call<StorageState>('storage.get'),
    estimate: (patch) =>
      call<StorageEstimate>('storage.estimate', patch ? [patch] : []),
    set: (patch) => call<StorageState>('storage.set', [patch]),
  };
}
