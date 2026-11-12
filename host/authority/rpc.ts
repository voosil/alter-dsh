/**
 * Browser-facing RPC dispatch for the Space authority.
 *
 * The Host registers this handler on a DSH Connection RPC route
 * (`ctx.connection.fetch`), which already enforces browser authentication and
 * the Host/Origin fence. Requests carry `{ op, args }`; a result is
 * `{ value }` or `{ error: { code, message } }`.
 */
import type {
  NewSpaceInput,
  SpaceActor,
  SpacePatch,
  SpaceService,
} from '@alter/protocol';
import {
  MAX_ASSET_BYTES,
  MAX_FILE_BYTES,
  type DocumentAssets,
  type ImportAssetInput,
  type ImportFileInput,
} from '../document/asset-store.js';
import type {
  ApplyOperationsInput,
  DocumentService,
  GenerateDocumentInput,
} from '../document/editors/legacy/service.js';
import { DocumentError } from '../document/editors/legacy/types.js';
import type { SpaceStorageApi } from '../persistence/storage.js';
import { WorkspaceSyncError, type SpaceWorkspaceSync } from '../workspace/sync.js';
import {
  STORAGE_LIMITS,
  type StorageSettings,
} from '../persistence/settings.js';

/** Exact `/api` fetch-route path the browser posts to (Connection owns auth). */
export const RPC_ROUTE_PATH = '/api/alter-space';
/** Endpoint name the browser puts in the Connection RPC envelope. */
export const RPC_ENDPOINT = 'alter-space';

/** space.* business methods on the browser whitelist. */
export const SPACE_METHODS = [
  'listSpaces',
  'getSpace',
  'createSpace',
  'updateSpace',
  'archiveSpace',
  'unarchiveSpace',
  'listArchivedSpaces',
  'deleteSpace',
  'reorderSpaces',
  'listNodes',
  'getNode',
  'createNode',
  'saveNode',
  'moveNode',
  'setPinned',
  'setArchived',
  'deleteNode',
  'restoreNode',
  'recordOpen',
  'listComments',
  'addComment',
  'updateComment',
  'addCommentSupplement',
  'deleteComment',
  'resolveComment',
  'listVersions',
  'restoreVersion',
  'listThoughts',
  'createThought',
  'updateThought',
  'setThoughtArchived',
  'deleteThought',
  'restoreThought',
  'moveThought',
  'convertThought',
  'listDeleted',
  'emptyTrash',
  'search',
  'getOverview',
  'listAgents',
  'createAgent',
  'listDirectories',
] as const;

/** hub.* business methods on the browser whitelist. */
export const HUB_METHODS = [
  'get',
  'createMatter',
  'setMatterStatus',
  'answerMatter',
  'readMatter',
  'saveJourney',
  'introduce',
  'skipIntroduction',
  'acceptObservation',
  'extractSkill',
  'setPolicy',
  'setPluginEnabled',
  'discoverPlugin',
  'savePluginContent',
  'summarize',
  'remove',
] as const;

/** storage.* methods on the browser whitelist. */
export const STORAGE_METHODS = ['get', 'estimate', 'set'] as const;

/** doc.* methods on the browser whitelist. */
export const DOCUMENT_METHODS = [
  'get',
  'outline',
  'read',
  'search',
  'applyOps',
  'undo',
  'restoreVersion',
  'generate',
  'importAsset',
  'importFile',
  'updateObject',
] as const;
/** object.* methods on the browser whitelist. */
export const OBJECT_METHODS = ['get'] as const;

const SPACE_METHOD_SET: ReadonlySet<string> = new Set(SPACE_METHODS);
const HUB_METHOD_SET: ReadonlySet<string> = new Set(HUB_METHODS);
const STORAGE_METHOD_SET: ReadonlySet<string> = new Set(STORAGE_METHODS);
const DOCUMENT_METHOD_SET: ReadonlySet<string> = new Set(DOCUMENT_METHODS);
const OBJECT_METHOD_SET: ReadonlySet<string> = new Set(OBJECT_METHODS);

/** Settings endpoints served by the plugin core, not by an authority backend. */
export const SETTINGS_METHODS = ['get', 'update', 'test'] as const;
/** Sync endpoints served by the plugin core. */
export const SYNC_METHODS = ['status', 'flush', 'queue', 'resolve'] as const;
/** Migration endpoints served by the plugin core. */
export const MIGRATION_METHODS = [
  'preflight',
  'start',
  'status',
  'cancel',
] as const;

/**
 * Whether an endpoint belongs to the plugin control plane (settings/sync).
 * These never reach an authority backend; the plugin route dispatches them
 * to the settings handler.
 */
export function isPluginControlEndpoint(endpoint: string): boolean {
  const [group, method] = endpoint.split('.');
  if (method === undefined) return false;
  if (group === 'settings')
    return (SETTINGS_METHODS as readonly string[]).includes(method);
  if (group === 'sync')
    return (SYNC_METHODS as readonly string[]).includes(method);
  return false;
}

/** Whether an endpoint belongs to the migration control plane. */
export function isMigrationEndpoint(endpoint: string): boolean {
  const [group, method] = endpoint.split('.');
  return (
    group === 'migration' &&
    method !== undefined &&
    (MIGRATION_METHODS as readonly string[]).includes(method)
  );
}

const MAX_ARGS = 16;

/** One RPC failure with a stable machine code. */
export class SpaceRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpaceRpcError';
    this.code = code;
  }
}

export type SpaceRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: unknown,
) => Promise<unknown>;

export interface SpaceRpcOptions {
  /** User-identity stack: the browser entrance. */
  service: SpaceService;
  /** Alter-identity stack: required for passthrough `alter` requests. */
  agentService?: SpaceService;
  storage: SpaceStorageApi;
  /**
   * Lazy resolver for the Space ↔ DSH workspace bridge. It is absent while
   * the Host has no `workspaceRegistry` service (the Space feature then keeps
   * working without workspace sync), and may appear later when the service
   * loads, hence the resolver form.
   */
  workspaceSync?: () => SpaceWorkspaceSync | undefined;
  /** User-identity document service; absent when the feature is disabled. */
  document?: DocumentService;
  /** Alter-identity document service for passthrough `alter` doc writes. */
  agentDocument?: DocumentService;
  /** Document asset store; absent disables `doc.importAsset` / `doc.importFile`. */
  assets?: DocumentAssets;
  /**
   * How the route selects the write-identity stack. The local Host route is a
   * user browser (`browser`): it always selects the user stack and ignores any
   * caller-supplied actor. The standalone server (`passthrough`) trusts the
   * bridge's stamped actor to select the stack, then strips the actor from
   * the arguments — services never see per-call identities.
   */
  actorPolicy?: 'browser' | 'passthrough';
  /**
   * Take a recovery point before a space is deleted.
   *
   * Deleting a space is the one operation that removes documents, versions,
   * comments and history together, and it cannot be undone from inside the app.
   * The caller supplies a snapshot; a failure aborts the delete (fail closed)
   * instead of destroying data that has no way back.
   */
  snapshotBeforeSpaceDelete?: () => Promise<unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Snapshot the database before a space is destroyed.
 *
 * A snapshot failure must stop the delete: the whole point of the step is that
 * the removed space is recoverable, so continuing would delete data with no way
 * back (and the user was told a backup is taken).
 */
async function takeDeleteRecoveryPoint(
  snapshot: (() => Promise<unknown>) | undefined,
): Promise<void> {
  if (snapshot === undefined) return;
  try {
    await snapshot();
  } catch (error) {
    throw new SpaceRpcError(
      'space/snapshot-failed',
      `删除前无法创建恢复点，已取消删除以保护数据：${messageOf(error)}`,
    );
  }
}

function normalizeArgs(payload: unknown): unknown[] {
  if (!isPlainObject(payload)) return [];
  const args = payload.args;
  if (!Array.isArray(args)) return [];
  return args.slice(0, MAX_ARGS);
}

const STORAGE_SETTING_KEYS = ['historyLimit', 'snapshotKeep'] as const;

/** Validate one storage settings patch; absent fields keep their value. */
function readStoragePatch(input: unknown): Partial<StorageSettings> {
  if (input === undefined) return {};
  if (!isPlainObject(input))
    throw new SpaceRpcError('space/invalid-input', '存储设置必须是对象');
  const patch: Partial<StorageSettings> = {};
  for (const key of STORAGE_SETTING_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const limits = STORAGE_LIMITS[key];
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new SpaceRpcError(
        'space/invalid-input',
        `${key} 必须是整数`,
      );
    if (value < limits.min || value > limits.max)
      throw new SpaceRpcError(
        'space/invalid-input',
        `${key} 需在 ${limits.min}–${limits.max} 之间`,
      );
    patch[key] = value;
  }
  return patch;
}

/** Standard base64 with optional trailing padding; whitespace is rejected. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Public fields `doc.importAsset` returns; hashes/timestamps stay Host-side. */
interface ImportedAssetResult {
  assetId: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** Public fields `doc.importFile` returns. */
interface ImportedFileResult {
  assetId: string;
  mime: string;
  bytes: number;
  name?: string;
}

interface ImportDecodeLimits {
  maxBytes: number;
  tooLargeCode: 'object/invalid' | 'doc/too-large';
  label: string;
}

const IMAGE_DECODE_LIMITS: ImportDecodeLimits = {
  maxBytes: MAX_ASSET_BYTES,
  tooLargeCode: 'object/invalid',
  label: '资产',
};

const FILE_DECODE_LIMITS: ImportDecodeLimits = {
  maxBytes: MAX_FILE_BYTES,
  tooLargeCode: 'doc/too-large',
  label: '文件',
};

/** Decode one browser-uploaded payload, rejecting malformed base64. */
function decodeBase64(encoded: string, limits: ImportDecodeLimits): Uint8Array {
  const compact = encoded.trim();
  if (compact.length === 0)
    throw new DocumentError('object/invalid', `${limits.label}内容为空`);
  // Guard before decoding so a pathological payload cannot be buffered.
  if (compact.length > Math.ceil(limits.maxBytes / 3) * 4)
    throw new DocumentError(
      limits.tooLargeCode,
      `${limits.label}超过上限 ${limits.maxBytes} 字节`,
    );
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact))
    throw new DocumentError(
      'object/invalid',
      `${limits.label}内容不是合法的 base64`,
    );
  const data = Buffer.from(compact, 'base64');
  if (data.byteLength === 0)
    throw new DocumentError('object/invalid', `${limits.label}内容为空`);
  return new Uint8Array(data);
}

interface RawImportInput {
  mime: string;
  dataBase64: string;
  name?: string;
}

/** Validate the shared `{ mime, dataBase64, name? }` upload argument. */
function readRawImportInput(input: unknown, label: string): RawImportInput {
  if (!isPlainObject(input))
    throw new DocumentError('object/invalid', `${label}参数必须是对象`);
  const { mime, dataBase64, name } = input;
  if (typeof mime !== 'string' || mime.trim() === '')
    throw new DocumentError('object/invalid', 'mime 必须是非空字符串');
  if (typeof dataBase64 !== 'string')
    throw new DocumentError('object/invalid', 'dataBase64 必须是字符串');
  if (name !== undefined && typeof name !== 'string')
    throw new DocumentError('object/invalid', 'name 必须是字符串');
  const trimmedName = name?.trim();
  return {
    mime,
    dataBase64,
    ...(trimmedName === undefined || trimmedName === ''
      ? {}
      : { name: trimmedName }),
  };
}

/** Validate one `doc.importAsset` argument into a store import request. */
function readImportAssetInput(input: unknown): ImportAssetInput {
  const raw = readRawImportInput(input, '资产');
  return {
    data: decodeBase64(raw.dataBase64, IMAGE_DECODE_LIMITS),
    mime: raw.mime,
    ...(raw.name === undefined ? {} : { name: raw.name }),
  };
}

/** Validate one `doc.importFile` argument into a store import request. */
function readImportFileInput(input: unknown): ImportFileInput {
  const raw = readRawImportInput(input, '文件');
  return {
    data: decodeBase64(raw.dataBase64, FILE_DECODE_LIMITS),
    mime: raw.mime,
    ...(raw.name === undefined ? {} : { name: raw.name }),
  };
}

/** Import one uploaded asset and project its public fields for the browser. */
async function importDocumentAsset(
  assets: DocumentAssets | undefined,
  input: unknown,
): Promise<ImportedAssetResult> {
  if (assets === undefined)
    throw new SpaceRpcError('doc/unavailable', '资产存储未启用');
  const record = await assets.import(readImportAssetInput(input));
  return {
    assetId: record.id,
    mime: record.mime,
    bytes: record.bytes,
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
  };
}

/** Import one uploaded file asset and project its public fields. */
async function importDocumentFile(
  assets: DocumentAssets | undefined,
  input: unknown,
): Promise<ImportedFileResult> {
  if (assets === undefined)
    throw new SpaceRpcError('doc/unavailable', '资产存储未启用');
  const record = await assets.importFile(readImportFileInput(input));
  return {
    assetId: record.id,
    mime: record.mime,
    bytes: record.bytes,
    ...(record.name === undefined ? {} : { name: record.name }),
  };
}

/**
 * Read the write identity the bridge stamped onto a passthrough request.
 * The stamp lives on the payload envelope (structure writes) or on the first
 * argument (document writes, whose queued replays carry it inline). Only an
 * explicit `alter` escalates; anything else stays `user`.
 */
function stampedActor(payload: unknown): SpaceActor {
  const record = isPlainObject(payload) ? payload : {};
  // An explicit envelope stamp is authoritative: the bridge overwrites any
  // caller claim, so a forged inline actor can never outrank it.
  if (record.actor === 'alter') return 'alter';
  if (record.actor === 'user') return 'user';
  // No envelope stamp: queued document replays carry the identity inline.
  const args = Array.isArray(record.args) ? record.args : [];
  const first = args[0];
  if (isPlainObject(first) && first.actor === 'alter') return 'alter';
  return 'user';
}

/** Identity is stack-bound: arguments never carry an actor into services. */
function stripActor(args: unknown[]): unknown[] {
  const first = args[0];
  if (!isPlainObject(first) || first.actor === undefined) return args;
  const cleaned = { ...first };
  delete cleaned.actor;
  return [cleaned, ...args.slice(1)];
}

/**
 * Create the RPC handler for one opened authority.
 * @param options - the composed business service.
 */
export function createSpaceRpc(options: SpaceRpcOptions): SpaceRpcHandler {
  const { service, storage } = options;
  const passthrough = options.actorPolicy === 'passthrough';
  return async (endpoint, payload) => {
    // Select the write-identity stack per request, then strip the actor from
    // the arguments. Browser routes always speak for the user regardless of
    // what the request body claims.
    const actor: SpaceActor = passthrough ? stampedActor(payload) : 'user';
    if (actor === 'alter' && options.agentService === undefined)
      return {
        error: { code: 'space/failed', message: 'Agent 权威栈未配置' },
      };
    const activeService = actor === 'alter' ? options.agentService! : service;
    const activeDocument =
      actor === 'alter' ? options.agentDocument : options.document;
    const args = stripActor(normalizeArgs(payload));
    try {
      const [group, method] = endpoint.split('.');
      if (method === undefined) {
        throw new SpaceRpcError(
          'space/not-found',
          `未知的接口 ${endpoint}`,
        );
      }
      if (group === 'storage' && STORAGE_METHOD_SET.has(method)) {
        if (method === 'get') return { value: await storage.get() };
        const patch = readStoragePatch(args[0]);
        if (method === 'estimate')
          return { value: await storage.estimate(patch) };
        return { value: await storage.set(patch) };
      }
      if (group === 'space' && SPACE_METHOD_SET.has(method)) {
        if (method === 'deleteSpace')
          await takeDeleteRecoveryPoint(options.snapshotBeforeSpaceDelete);
        const sync = options.workspaceSync?.();
        if (sync !== undefined) {
          if (method === 'createSpace') {
            const value = await sync.createSpace(
              activeService,
              args[0] as NewSpaceInput,
            );
            return { value: value === undefined ? null : value };
          }
          if (method === 'updateSpace') {
            const value = await sync.updateSpace(
              activeService,
              String(args[0]),
              args[1] as SpacePatch,
            );
            return { value: value === undefined ? null : value };
          }
          if (method === 'unarchiveSpace') {
            const value = await sync.unarchiveSpace(activeService, String(args[0]));
            return { value: value === undefined ? null : value };
          }
          if (method === 'deleteSpace') {
            await sync.deleteSpace(activeService, String(args[0]));
            return { value: null };
          }
        }
        const target = activeService as unknown as Record<
          string,
          (...callArgs: unknown[]) => unknown
        >;
        const value = await target[method](...args);
        return { value: value === undefined ? null : value };
      }
      if (group === 'doc' && DOCUMENT_METHOD_SET.has(method)) {
        if (method === 'importAsset')
          return { value: await importDocumentAsset(options.assets, args[0]) };
        if (method === 'importFile')
          return { value: await importDocumentFile(options.assets, args[0]) };
        const document = activeDocument;
        if (document === undefined)
          throw new SpaceRpcError('doc/unavailable', '文档模型服务未启用');
        switch (method) {
          case 'get':
            return { value: await document.get(String(args[0])) };
          case 'outline':
            return { value: await document.outline(String(args[0])) };
          case 'read':
            return {
              value: await document.read(
                String(args[0]),
                (args[1] ?? {}) as Parameters<DocumentService['read']>[1],
              ),
            };
          case 'search':
            return {
              value: await document.search(
                (args[0] ?? {}) as Parameters<DocumentService['search']>[0],
              ),
            };
          case 'applyOps':
            return {
              value: await document.applyOperations(
                args[0] as ApplyOperationsInput,
              ),
            };
          case 'undo':
            return {
              value: await document.undo(
                args[0] as Parameters<DocumentService['undo']>[0],
              ),
            };
          case 'restoreVersion':
            return {
              value: await document.restoreVersion(
                args[0] as Parameters<DocumentService['restoreVersion']>[0],
              ),
            };
          case 'generate':
            return {
              value: await document.generate(
                args[0] as GenerateDocumentInput,
              ),
            };
          case 'updateObject':
            return {
              value: await document.updateObject(
                args[0] as Parameters<DocumentService['updateObject']>[0],
              ),
            };
          default:
            break;
        }
      }
      if (group === 'object' && OBJECT_METHOD_SET.has(method)) {
        const document = activeDocument;
        if (document === undefined)
          throw new SpaceRpcError('doc/unavailable', '文档模型服务未启用');
        if (method === 'get')
          return { value: (await document.getObject(String(args[0]))) ?? null };
      }
      if (group === 'hub' && HUB_METHOD_SET.has(method)) {
        const target = activeService.hub as unknown as Record<
          string,
          (...callArgs: unknown[]) => unknown
        >;
        const value = await target[method](...args);
        return { value: value === undefined ? null : value };
      }
      throw new SpaceRpcError('space/not-found', `未知的接口 ${endpoint}`);
    } catch (error) {
      if (error instanceof DocumentError)
        return { error: { code: error.code, message: error.message } };
      if (error instanceof WorkspaceSyncError)
        return { error: { code: error.code, message: error.message } };
      if (error instanceof SpaceRpcError)
        return { error: { code: error.code, message: error.message } };
      return {
        error: { code: 'space/failed', message: messageOf(error) },
      };
    }
  };
}

/**
 * In-process dispatcher for the Agent tool surface.
 *
 * The business handler is the same one the browser uses, but this entrance is
 * forced onto the alter identity stack (`actorPolicy: 'passthrough'` with the
 * stamp applied here). It is never mounted on a route: only Host code reaches
 * it (local Agent tools and the bridge test harness), so no browser request can
 * use it to claim `alter`.
 *
 * Business failures are thrown as coded errors so the tool layer keeps its
 * stable vocabulary, and read endpoints stay reads for the migration freeze
 * and the offline cache.
 */
export function createAgentRpcHandler(
  options: Omit<SpaceRpcOptions, 'actorPolicy'>,
): (endpoint: string, args: unknown[], signal?: AbortSignal) => Promise<unknown> {
  const handler = createSpaceRpc({ ...options, actorPolicy: 'passthrough' });
  return async (endpoint, args, signal) => {
    const result = await handler(
      endpoint,
      { op: endpoint, args, actor: 'alter' },
      signal ?? new AbortController().signal,
      undefined,
    );
    if (isPlainObject(result) && isPlainObject(result.error)) {
      const error = result.error;
      const code = typeof error.code === 'string' ? error.code : 'space/failed';
      const message =
        typeof error.message === 'string' ? error.message : '空间操作失败';
      throw Object.assign(new Error(message), { code });
    }
    return isPlainObject(result) ? result.value : result;
  };
}

/**
 * Fetch-route handler mounted at {@link RPC_ROUTE_PATH} through
 * `ctx.connection.fetch.register`. Connection authenticates the browser and
 * calls this with the validated peer; the request body is the Connection RPC
 * envelope, so the response must echo its `rpcId`.
 */
export function createSpaceFetchRoute(options: SpaceRpcOptions) {
  return createConnectionFetchRoute(createSpaceRpc(options));
}

interface ConnectionRequestEnvelope {
  rpcId: string;
  payload: unknown;
}

function parseConnectionEnvelope(body: unknown): ConnectionRequestEnvelope | undefined {
  if (!isPlainObject(body)) return undefined;
  if (body.type !== 'client-request') return undefined;
  if (typeof body.rpcId !== 'string' || body.rpcId.length === 0) return undefined;
  return { rpcId: body.rpcId, payload: body.payload };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Fetch-route handler mounted at {@link RPC_ROUTE_PATH} through
 * `ctx.connection.fetch.register`. Connection authenticates the browser and
 * calls this with the validated peer; the request body is the Connection RPC
 * envelope, so the response must echo its `rpcId`.
 */
export function createConnectionFetchRoute(
  handler: SpaceRpcHandler,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST')
      return jsonResponse(405, { error: 'method_not_allowed' });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const envelope = parseConnectionEnvelope(body);
    if (!envelope) return jsonResponse(400, { error: 'invalid_envelope' });
    const payload = isPlainObject(envelope.payload) ? envelope.payload : {};
    const op = typeof payload.op === 'string' ? payload.op : '';
    let result: unknown;
    try {
      result = await handler(op, payload, request.signal, undefined);
    } catch {
      return jsonResponse(500, { error: 'handler_failure' });
    }
    // Business failures stay inside the success value: the browser unwraps
    // `{ value }` / `{ error }` without depending on Connection's error schema.
    return jsonResponse(200, {
      type: 'server-response',
      rpcId: envelope.rpcId,
      result: { ok: true, value: result },
    });
  };
}
