/**
 * Browser implementation of the Space `SpaceService`, backed by the Host over
 * the DSH Connection RPC channel.
 *
 * `SpaceApp` only knows the `SpaceService` interface, so this
 * module is the seam that turns each product call into one RPC endpoint. The
 * Host owns the data; the browser keeps no business state.
 */
import type { SpaceService } from '@alter/protocol';

/**
 * Connection HTTP channel and endpoint used by the Host half; keep in sync
 * with `host/authority/rpc.ts` (`RPC_ROUTE_PATH` / `RPC_ENDPOINT`).
 */
export const SPACE_RPC_CHANNEL = '/api';
export const SPACE_RPC_ENDPOINT = 'alter-space';

export interface SpaceRpcErrorInfo {
  code: string;
  message: string;
}

/** Result envelope of the Host's Space RPC handler. */
export type SpaceRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: SpaceRpcErrorInfo };

/** Minimal structural contract implemented by `ctx.connection.rpc`. */
export interface SpaceRpcCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<SpaceRpcResult>;
}

/** Business failure raised by the Host; carries its stable code. */
export class SpaceRemoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpaceRemoteError';
    this.code = code;
  }
}

function trimTrailingUndefined(args: unknown[]): unknown[] {
  const copy = args.slice();
  while (copy.length > 0 && copy[copy.length - 1] === undefined) copy.pop();
  return copy;
}

function remoteError(error: unknown): SpaceRemoteError {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message =
      typeof record.message === 'string' ? record.message : '空间操作失败';
    const code = typeof record.code === 'string' ? record.code : 'space/failed';
    return new SpaceRemoteError(code, message);
  }
  return new SpaceRemoteError('space/failed', '空间操作失败');
}

/**
 * Build the browser-side `SpaceService`.
 * @param rpc - the client Connection RPC caller.
 */
export function createSpaceClient(rpc: SpaceRpcCaller): SpaceService {
  // Serialize calls so a save always resolves before the refreshes it
  // triggers: out-of-order responses used to flash older content back into the
  // editor right after a successful save.
  let chain: Promise<unknown> = Promise.resolve();

  function call<T>(endpoint: string, args: unknown[] = []): Promise<T> {
    const run = chain.then(() => request<T>(endpoint, args));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function request<T>(
    endpoint: string,
    args: unknown[],
  ): Promise<T> {
    const result = await rpc.call(SPACE_RPC_CHANNEL, SPACE_RPC_ENDPOINT, {
      op: endpoint,
      args: trimTrailingUndefined(args),
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

  const spaceCall = <T>(method: string, args: unknown[] = []): Promise<T> =>
    call<T>(`space.${method}`, args);
  const hubCall = <T>(method: string, args: unknown[] = []): Promise<T> =>
    call<T>(`hub.${method}`, args);
  const voidCall = (endpoint: string, args: unknown[] = []): Promise<void> =>
    call<null>(endpoint, args).then(() => undefined);

  return {
    hub: {
      get: (spaceId) => hubCall('get', [spaceId]),
      createMatter: (spaceId, title, description, source) =>
        hubCall('createMatter', [spaceId, title, description, source]),
      setMatterStatus: (spaceId, id, status, reason) =>
        voidCall('hub.setMatterStatus', [spaceId, id, status, reason]),
      answerMatter: (spaceId, id, answers) =>
        voidCall('hub.answerMatter', [spaceId, id, answers]),
      readMatter: (spaceId, id) => voidCall('hub.readMatter', [spaceId, id]),
      saveJourney: (spaceId, patch) =>
        voidCall('hub.saveJourney', [spaceId, patch]),
      introduce: (spaceId, background, vision, next) =>
        voidCall('hub.introduce', [spaceId, background, vision, next]),
      skipIntroduction: (spaceId) =>
        voidCall('hub.skipIntroduction', [spaceId]),
      acceptObservation: (spaceId, id, accepted) =>
        voidCall('hub.acceptObservation', [spaceId, id, accepted]),
      extractSkill: (spaceId, id, instructions) =>
        voidCall('hub.extractSkill', [spaceId, id, instructions]),
      setPolicy: (spaceId, policy) =>
        voidCall('hub.setPolicy', [spaceId, policy]),
      setPluginEnabled: (spaceId, id, enabled) =>
        voidCall('hub.setPluginEnabled', [spaceId, id, enabled]),
      discoverPlugin: (spaceId, label, purpose) =>
        hubCall('discoverPlugin', [spaceId, label, purpose]),
      savePluginContent: (spaceId, id, content) =>
        voidCall('hub.savePluginContent', [spaceId, id, content]),
      summarize: (spaceId) => voidCall('hub.summarize', [spaceId]),
      // Fire-and-forget by contract; the Host still persists the removal.
      remove: (spaceId) => {
        void hubCall('remove', [spaceId]).catch(() => undefined);
      },
    },

    listSpaces: () => spaceCall('listSpaces'),
    getSpace: async (id) =>
      (await spaceCall('getSpace', [id])) ?? undefined,
    createSpace: (input) => spaceCall('createSpace', [input]),
    updateSpace: (id, patch) => spaceCall('updateSpace', [id, patch]),
    archiveSpace: (id) => spaceCall('archiveSpace', [id]),
    unarchiveSpace: (id) => spaceCall('unarchiveSpace', [id]),
    listArchivedSpaces: () => spaceCall('listArchivedSpaces'),
    deleteSpace: (id) => voidCall('space.deleteSpace', [id]),
    reorderSpaces: (ids) => spaceCall('reorderSpaces', [ids]),

    listNodes: (spaceId) => spaceCall('listNodes', [spaceId]),
    getNode: async (id) => (await spaceCall('getNode', [id])) ?? undefined,
    createNode: (input) => spaceCall('createNode', [input]),
    saveNode: (id, patch) => spaceCall('saveNode', [id, patch]),
    moveNode: (id, target) => spaceCall('moveNode', [id, target]),
    setPinned: (id, pinned) => spaceCall('setPinned', [id, pinned]),
    setArchived: (id, archived) => spaceCall('setArchived', [id, archived]),
    deleteNode: (id) => voidCall('space.deleteNode', [id]),
    restoreNode: (id) => spaceCall('restoreNode', [id]),
    recordOpen: (id) => spaceCall('recordOpen', [id]),

    listComments: (docId) => spaceCall('listComments', [docId]),
    addComment: (input) => spaceCall('addComment', [input]),
    updateComment: (id, patch) => spaceCall('updateComment', [id, patch]),
    addCommentSupplement: (id, body) =>
      spaceCall('addCommentSupplement', [id, body]),
    deleteComment: (id) => voidCall('space.deleteComment', [id]),
    resolveComment: (id) => spaceCall('resolveComment', [id]),
    listVersions: (docId) => spaceCall('listVersions', [docId]),
    restoreVersion: (docId, versionId) =>
      spaceCall('restoreVersion', [docId, versionId]),

    listThoughts: (spaceId, options) =>
      spaceCall('listThoughts', [spaceId, options]),
    createThought: (input) => spaceCall('createThought', [input]),
    updateThought: (id, content) => spaceCall('updateThought', [id, content]),
    setThoughtArchived: (id, archived) =>
      spaceCall('setThoughtArchived', [id, archived]),
    deleteThought: (id) => voidCall('space.deleteThought', [id]),
    restoreThought: (id) => spaceCall('restoreThought', [id]),
    moveThought: (id, spaceId) => spaceCall('moveThought', [id, spaceId]),
    convertThought: (id) => spaceCall('convertThought', [id]),

    listDeleted: (spaceId) => spaceCall('listDeleted', [spaceId]),
    emptyTrash: (spaceId) => voidCall('space.emptyTrash', [spaceId]),
    search: (spaceId, query) => spaceCall('search', [spaceId, query]),
    getOverview: (spaceId) => spaceCall('getOverview', [spaceId]),

    listAgents: () => spaceCall('listAgents'),
    createAgent: (input) => spaceCall('createAgent', [input]),

    listDirectories: (path) => spaceCall('listDirectories', [path ?? '~']),
  };
}

/** One node reference produced by the document projection. */
export interface SpaceDocumentBlockRef {
  id: string;
  type: string;
}

/** Browser upload input for `doc.importAsset`. */
export interface SpaceImportAssetInput {
  /** Image media type: `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
  mime: string;
  /** Pure base64 bytes (no data-URL prefix, no line breaks); ≤ 4 MiB decoded. */
  dataBase64: string;
  /** Optional display name. */
  name?: string;
}

/** Public asset metadata returned by `doc.importAsset`. */
export interface SpaceImportedAsset {
  assetId: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** Browser upload input for `doc.importFile`. */
export interface SpaceImportFileInput {
  /**
   * Whitelisted file media type: the image types, `application/pdf`,
   * `text/plain`, `text/markdown`, `text/csv`, `application/json`,
   * `application/zip` or an Office Open XML document type.
   */
  mime: string;
  /** Pure base64 bytes (no data-URL prefix, no line breaks); ≤ 8 MiB decoded. */
  dataBase64: string;
  /** Optional display name, used as the download filename. */
  name?: string;
}

/** Public file-asset metadata returned by `doc.importFile`. */
export interface SpaceImportedFile {
  assetId: string;
  mime: string;
  bytes: number;
  name?: string;
}

/** Document client mirror of the Host `doc.*` RPC endpoints. */
export interface SpaceDocumentClient {
  get(docId: string): Promise<unknown>;
  outline(docId: string): Promise<unknown>;
  read(docId: string, options?: Record<string, unknown>): Promise<unknown>;
  search(input: {
    query: string;
    docId?: string;
    spaceId?: string;
    limit?: number;
  }): Promise<unknown>;
  applyOperations(input: {
    docId: string;
    baseRevision: number;
    ops: unknown[];
    dryRun?: boolean;
    idempotencyKey?: string;
  }): Promise<unknown>;
  undo(input: {
    docId: string;
    baseRevision: number;
    undoToken?: string;
  }): Promise<unknown>;
  restoreVersion(input: {
    docId: string;
    versionId: string;
    baseRevision: number;
  }): Promise<unknown>;
  generate(input: {
    docId?: string;
    spaceId?: string;
    title?: string;
    parent?: string | null;
    after?: string;
    markdown: string;
  }): Promise<unknown>;
  importAsset(input: SpaceImportAssetInput): Promise<SpaceImportedAsset>;
  importFile(input: SpaceImportFileInput): Promise<SpaceImportedFile>;
  getObject(objectId: string): Promise<unknown>;
  updateObject(input: {
    docId: string;
    blockId: string;
    baseRevision: number;
    payload: unknown;
  }): Promise<unknown>;
}

/**
 * Build the browser-side document client over the same Connection RPC
 * channel as the Space service.
 * @param rpc - the client Connection RPC caller.
 */
export function createSpaceDocumentClient(
  rpc: SpaceRpcCaller,
): SpaceDocumentClient {
  async function request<T>(endpoint: string, args: unknown[]): Promise<T> {
    const result = await rpc.call(SPACE_RPC_CHANNEL, SPACE_RPC_ENDPOINT, {
      op: endpoint,
      args: trimTrailingUndefined(args),
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
    get: (docId) => request('doc.get', [docId]),
    outline: (docId) => request('doc.outline', [docId]),
    read: (docId, options) => request('doc.read', [docId, options]),
    search: (input) => request('doc.search', [input]),
    applyOperations: (input) => request('doc.applyOps', [input]),
    undo: (input) => request('doc.undo', [input]),
    restoreVersion: (input) => request('doc.restoreVersion', [input]),
    generate: (input) => request('doc.generate', [input]),
    importAsset: (input) => request('doc.importAsset', [input]),
    importFile: (input) => request('doc.importFile', [input]),
    getObject: (objectId) => request('object.get', [objectId]),
    updateObject: (input) => request('doc.updateObject', [input]),
  };
}

/** Link/authority facts shown in the server settings section. */
export interface SpaceConnectionStatus {
  state: 'local' | 'connecting' | 'online' | 'offline' | 'error';
  message?: string;
  serverVersion?: string;
  protocolVersion?: number;
  pendingWrites?: number;
  conflicts?: number;
  lastSyncedAt?: string;
}

/** Non-secret settings snapshot returned by the Host control plane. */
export interface SpaceSettingsSnapshot {
  mode: 'local' | 'server';
  serverUrl: string | null;
  tokenConfigured: boolean;
  updatedAt: string;
  connection: SpaceConnectionStatus;
  capabilities: {
    remoteDirectories: boolean;
    workspaceMapping: boolean;
    agentConfigurable: boolean;
  };
  sync: {
    pendingWrites: number;
    conflicts: number;
    failed: number;
    lastSyncedAt?: string;
  };
}

/** Outcome of one server reachability/compatibility probe. */
export interface SpaceRemoteTestResult {
  ok: boolean;
  serverVersion?: string;
  protocolVersion?: number;
  databaseSchemaVersion?: number;
  authenticated?: boolean;
  message?: string;
}

/** One document with queued writes that have not reached the server. */
export interface SpaceSyncQueueEntry {
  docId: string;
  /** `pending` waits for the link; the others need a user decision. */
  state: 'pending' | 'conflict' | 'failed';
  /** Number of queue entries for this document. */
  entries: number;
  baseRevision: number;
  /** Last failure message, when the server rejected a replay. */
  lastError?: string;
  updatedAt: string;
}

/** Client mirror of the Host settings/sync endpoints. */
export interface SpaceSettingsClient {
  get(): Promise<SpaceSettingsSnapshot>;
  update(patch: {
    mode?: 'local' | 'server';
    serverUrl?: string | null;
    token?: string | null;
  }): Promise<SpaceSettingsSnapshot>;
  test(input: {
    serverUrl?: string;
    token?: string | null;
  }): Promise<SpaceRemoteTestResult>;
  syncStatus(): Promise<SpaceSettingsSnapshot>;
  /** Documents whose queued document writes are still unsettled. */
  syncQueue(): Promise<SpaceSyncQueueEntry[]>;
  /** Retry or discard one document's queued writes. */
  resolveSync(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<{ resolved: number; state: SpaceSettingsSnapshot }>;
  flush(): Promise<SpaceSettingsSnapshot>;
}

/**
 * Build the browser-side settings client over the same Connection RPC channel
 * as the Space service.
 * @param rpc - the client Connection RPC caller.
 */
export function createSpaceSettingsClient(
  rpc: SpaceRpcCaller,
): SpaceSettingsClient {
  async function request<T>(endpoint: string, args: unknown[] = []): Promise<T> {
    const result = await rpc.call(SPACE_RPC_CHANNEL, SPACE_RPC_ENDPOINT, {
      op: endpoint,
      args: trimTrailingUndefined(args),
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
    get: () => request('settings.get'),
    update: (patch) => request('settings.update', [patch]),
    test: (input) => request('settings.test', [input]),
    syncStatus: () => request('sync.status'),
    syncQueue: () => request('sync.queue'),
    resolveSync: (docId, action) => request('sync.resolve', [{ docId, action }]),
    flush: () => request('sync.flush'),
  };
}

/** Migration direction accepted by the Host migration service. */
export type SpaceMigrationDirection = 'to-server' | 'from-server';

/** Preflight facts for one migration direction. */
export interface SpaceMigrationPreflight {
  server: {
    reachable: boolean;
    message?: string;
    empty?: boolean;
    protocolVersion?: number;
    databaseSchemaVersion?: number;
    counts?: Record<string, number> | null;
  };
  local: {
    databaseBytes: number;
    assetBytes: number;
    assetCount: number;
    hasUserData: boolean;
  };
  needsOverwrite: boolean;
  replacesLocal: boolean;
  ok: boolean;
  message?: string;
}

/** Live migration job state. */
export interface SpaceMigrationState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  direction?: SpaceMigrationDirection;
  phase?: string;
  message?: string;
  transferredBytes: number;
  totalBytes: number | null;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  counts?: Record<string, number>;
  backup?: string | null;
}

/** Client mirror of the Host migration endpoints. */
export interface SpaceMigrationClient {
  preflight(direction: SpaceMigrationDirection): Promise<SpaceMigrationPreflight>;
  start(input: {
    direction: SpaceMigrationDirection;
    overwrite?: boolean;
    trimHistory?: boolean;
  }): Promise<SpaceMigrationState>;
  status(): Promise<SpaceMigrationState>;
  cancel(): Promise<SpaceMigrationState>;
}

/**
 * Build the browser-side migration client over the Connection RPC channel.
 * @param rpc - the client Connection RPC caller.
 */
export function createSpaceMigrationClient(
  rpc: SpaceRpcCaller,
): SpaceMigrationClient {
  async function request<T>(endpoint: string, args: unknown[] = []): Promise<T> {
    const result = await rpc.call(SPACE_RPC_CHANNEL, SPACE_RPC_ENDPOINT, {
      op: endpoint,
      args: trimTrailingUndefined(args),
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
    preflight: (direction) =>
      request('migration.preflight', [{ direction }]),
    start: (input) => request('migration.start', [input]),
    status: () => request('migration.status'),
    cancel: () => request('migration.cancel'),
  };
}
