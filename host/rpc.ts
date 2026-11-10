/**
 * Browser-facing RPC dispatch for the Space authority.
 *
 * The Host registers this handler on a DSH Connection RPC route
 * (`ctx.connection.fetch`), which already enforces browser authentication and
 * the Host/Origin fence. Requests carry `{ op, args }`; a result is
 * `{ value }` or `{ error: { code, message } }`.
 */
import type { NewSpaceInput, SpacePatch, SpaceService } from '@alter/protocol';
import {
  MAX_ASSET_BYTES,
  type DocumentAssets,
  type ImportAssetInput,
} from './document/assets.js';
import type {
  ApplyOperationsInput,
  DocumentService,
  GenerateDocumentInput,
} from './document/service.js';
import { DocumentError } from './document/types.js';
import type { SpaceStorageApi } from './storage.js';
import { WorkspaceSyncError, type SpaceWorkspaceSync } from './workspace-sync.js';
import {
  STORAGE_LIMITS,
  type StorageSettings,
} from './settings.js';

/** Exact `/api` fetch-route path the browser posts to (Connection owns auth). */
export const RPC_ROUTE_PATH = '/api/alter-space';
/** Endpoint name the browser puts in the Connection RPC envelope. */
export const RPC_ENDPOINT = 'alter-space';

const SPACE_METHODS = [
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

const HUB_METHODS = [
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

const STORAGE_METHODS = ['get', 'estimate', 'set'] as const;

const DOCUMENT_METHODS = [
  'get',
  'outline',
  'read',
  'search',
  'applyOps',
  'undo',
  'restoreVersion',
  'generate',
  'importAsset',
] as const;
const OBJECT_METHODS = ['get'] as const;

const SPACE_METHOD_SET: ReadonlySet<string> = new Set(SPACE_METHODS);
const HUB_METHOD_SET: ReadonlySet<string> = new Set(HUB_METHODS);
const STORAGE_METHOD_SET: ReadonlySet<string> = new Set(STORAGE_METHODS);
const DOCUMENT_METHOD_SET: ReadonlySet<string> = new Set(DOCUMENT_METHODS);
const OBJECT_METHOD_SET: ReadonlySet<string> = new Set(OBJECT_METHODS);

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
  service: SpaceService;
  storage: SpaceStorageApi;
  /**
   * Lazy resolver for the Space ↔ DSH workspace bridge. It is absent while
   * the Host has no `workspaceRegistry` service (the Space feature then keeps
   * working without workspace sync), and may appear later when the service
   * loads, hence the resolver form.
   */
  workspaceSync?: () => SpaceWorkspaceSync | undefined;
  /** Document-model service; absent when the feature is disabled. */
  document?: DocumentService;
  /** Document asset store; absent disables `doc.importAsset`. */
  assets?: DocumentAssets;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Upper bound of a base64 payload that can still decode to {@link MAX_ASSET_BYTES}. */
const MAX_ASSET_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
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

/** Decode one browser-uploaded asset payload, rejecting malformed base64. */
function decodeAssetBase64(encoded: string): Uint8Array {
  const compact = encoded.trim();
  if (compact.length === 0)
    throw new DocumentError('object/invalid', '资产内容为空');
  if (compact.length > MAX_ASSET_BASE64_LENGTH)
    throw new DocumentError(
      'object/invalid',
      `资产超过上限 ${MAX_ASSET_BYTES} 字节`,
    );
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact))
    throw new DocumentError('object/invalid', '资产内容不是合法的 base64');
  const data = Buffer.from(compact, 'base64');
  if (data.byteLength === 0)
    throw new DocumentError('object/invalid', '资产内容为空');
  return new Uint8Array(data);
}

/** Validate one `doc.importAsset` argument into a store import request. */
function readImportAssetInput(input: unknown): ImportAssetInput {
  if (!isPlainObject(input))
    throw new DocumentError('object/invalid', '资产参数必须是对象');
  const { mime, dataBase64, name } = input;
  if (typeof mime !== 'string' || mime.trim() === '')
    throw new DocumentError('object/invalid', 'mime 必须是非空字符串');
  if (typeof dataBase64 !== 'string')
    throw new DocumentError('object/invalid', 'dataBase64 必须是字符串');
  if (name !== undefined && typeof name !== 'string')
    throw new DocumentError('object/invalid', 'name 必须是字符串');
  const trimmedName = name?.trim();
  return {
    data: decodeAssetBase64(dataBase64),
    mime,
    ...(trimmedName === undefined || trimmedName === ''
      ? {}
      : { name: trimmedName }),
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

/**
 * Create the RPC handler for one opened authority.
 * @param options - the composed business service.
 */
export function createSpaceRpc(options: SpaceRpcOptions): SpaceRpcHandler {
  const { service, storage } = options;
  return async (endpoint, payload) => {
    const args = normalizeArgs(payload);
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
        const sync = options.workspaceSync?.();
        if (sync !== undefined) {
          if (method === 'createSpace') {
            const value = await sync.createSpace(
              service,
              args[0] as NewSpaceInput,
            );
            return { value: value === undefined ? null : value };
          }
          if (method === 'updateSpace') {
            const value = await sync.updateSpace(
              service,
              String(args[0]),
              args[1] as SpacePatch,
            );
            return { value: value === undefined ? null : value };
          }
          if (method === 'unarchiveSpace') {
            const value = await sync.unarchiveSpace(service, String(args[0]));
            return { value: value === undefined ? null : value };
          }
          if (method === 'deleteSpace') {
            await sync.deleteSpace(service, String(args[0]));
            return { value: null };
          }
        }
        const target = service as unknown as Record<
          string,
          (...callArgs: unknown[]) => unknown
        >;
        const value = await target[method](...args);
        return { value: value === undefined ? null : value };
      }
      if (group === 'doc' && DOCUMENT_METHOD_SET.has(method)) {
        if (method === 'importAsset')
          return { value: await importDocumentAsset(options.assets, args[0]) };
        const document = options.document;
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
                (args[0] ?? {}) as ApplyOperationsInput,
              ),
            };
          case 'undo':
            return {
              value: await document.undo(
                (args[0] ?? {}) as Parameters<DocumentService['undo']>[0],
              ),
            };
          case 'restoreVersion':
            return {
              value: await document.restoreVersion(
                (args[0] ?? {}) as Parameters<DocumentService['restoreVersion']>[0],
              ),
            };
          case 'generate':
            return {
              value: await document.generate(
                (args[0] ?? {}) as GenerateDocumentInput,
              ),
            };
          default:
            break;
        }
      }
      if (group === 'object' && OBJECT_METHOD_SET.has(method)) {
        const document = options.document;
        if (document === undefined)
          throw new SpaceRpcError('doc/unavailable', '文档模型服务未启用');
        if (method === 'get')
          return { value: (await document.getObject(String(args[0]))) ?? null };
      }
      if (group === 'hub' && HUB_METHOD_SET.has(method)) {
        const target = service.hub as unknown as Record<
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
export function createSpaceFetchRoute(options: SpaceRpcOptions) {
  const handler = createSpaceRpc(options);
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
    } catch (error) {
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
