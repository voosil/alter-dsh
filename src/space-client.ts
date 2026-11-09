/**
 * Browser implementation of the Space `SpaceService`, backed by the Host over
 * the DSH Connection RPC channel.
 *
 * The vendored `SpaceApp` only knows the `SpaceService` interface, so this
 * module is the seam that turns each product call into one RPC endpoint. The
 * Host owns the data; the browser keeps no business state.
 */
import type { SpaceService } from '@alter/protocol';

/**
 * Connection HTTP channel and endpoint used by the Host half; keep in sync
 * with `host/rpc.ts` (`RPC_ROUTE_PATH` / `RPC_ENDPOINT`).
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
