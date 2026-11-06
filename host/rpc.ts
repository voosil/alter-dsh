/**
 * Browser-facing RPC dispatch for the Space authority.
 *
 * The Host registers this handler on a DSH Connection RPC channel
 * (`ctx.connection.rpc.handle`), which already enforces browser authentication
 * and the Host/Origin fence. Requests carry `{ args: unknown[] }`; a result is
 * `{ value }` or `{ error: { code, message } }`.
 *
 * `migrate.import` is the one non-SpaceService endpoint: it accepts the
 * normalized browser-local database and imports it only while the SQLite
 * authority is still pristine.
 */
import type { HubSnapshot, SpaceService } from '@alter/protocol';
import type {
  SpaceStoreData,
} from '../vendor/service/src/contracts.js';
import type { SpaceStoreHandle } from './store.js';
import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
} from './store.js';

/** RPC channel the browser calls; also the client-side constant. */
export const RPC_CHANNEL = '/alter-space';

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

const SPACE_METHOD_SET: ReadonlySet<string> = new Set(SPACE_METHODS);
const HUB_METHOD_SET: ReadonlySet<string> = new Set(HUB_METHODS);

const MAX_ARGS = 16;
const MAX_IMPORT_ENTITIES = 500_000;

const BUILTIN_PLUGINS: HubSnapshot['plugins'] = [
  {
    id: 'overview',
    label: '概览',
    description: '空间近况、活动与使用统计',
    builtin: true,
    required: true,
    enabled: true,
  },
  {
    id: 'config',
    label: '配置',
    description: '空间信息、协作者与插件',
    builtin: true,
    required: true,
    enabled: true,
  },
];

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
  store: SpaceStoreHandle;
  service: SpaceService;
  now: () => Date;
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

/** Imported entity rows keep their JSON shape; invalid ids are dropped. */
function collectEntities(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entities: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    entities.push(item);
  }
  return entities;
}

function filterBy(
  entities: Array<Record<string, unknown>>,
  field: string,
  allowed: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  return entities.filter((entity) => {
    const value = entity[field];
    return typeof value === 'string' && allowed.has(value);
  });
}

function defaultSpace(now: Date) {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    goal: '',
    directories: [] as string[],
    collaboratorIds: [] as string[],
    isDefault: true,
    order: 0,
    createdAt: now.toISOString(),
    archivedAt: null,
  };
}

function emptyJourney(at: string): HubSnapshot['journey'] {
  return {
    vision: '',
    shortTerm: '',
    longTerm: '',
    principles: '',
    background: '',
    updatedAt: at,
    nodes: [],
  };
}

function normalizeSnapshot(value: unknown, at: string): HubSnapshot {
  if (!isPlainObject(value)) {
    return {
      matters: [],
      journey: emptyJourney(at),
      observations: [],
      plugins: BUILTIN_PLUGINS.map((plugin) => ({ ...plugin })),
      policy: 'ask',
      onboarding: 'complete',
      summary: { content: '', updatedAt: '' },
      usage: [],
    };
  }
  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .filter(isPlainObject)
        .filter((plugin) => typeof plugin.id === 'string')
        .map((plugin) => ({
          id: String(plugin.id),
          label: typeof plugin.label === 'string' ? plugin.label : String(plugin.id),
          description:
            typeof plugin.description === 'string' ? plugin.description : '',
          builtin: plugin.builtin === true,
          required: plugin.required === true,
          enabled: plugin.enabled !== false,
          ...(typeof plugin.content === 'string'
            ? { content: plugin.content }
            : {}),
        }))
    : [];
  const journey = isPlainObject(value.journey)
    ? { ...emptyJourney(at), ...value.journey }
    : emptyJourney(at);
  const summary = isPlainObject(value.summary) ? value.summary : {};
  const policy =
    value.policy === 'judge' || value.policy === 'autonomous'
      ? value.policy
      : 'ask';
  const onboarding =
    value.onboarding === 'pending' || value.onboarding === 'skipped'
      ? value.onboarding
      : 'complete';
  return {
    matters: Array.isArray(value.matters)
      ? (value.matters.filter(isPlainObject) as unknown as HubSnapshot['matters'])
      : [],
    journey,
    observations: Array.isArray(value.observations)
      ? (value.observations.filter(
          isPlainObject,
        ) as unknown as HubSnapshot['observations'])
      : [],
    plugins: plugins.length > 0 ? plugins : BUILTIN_PLUGINS.map((p) => ({ ...p })),
    policy,
    onboarding,
    summary: {
      content: typeof summary.content === 'string' ? summary.content : '',
      updatedAt:
        typeof summary.updatedAt === 'string' ? summary.updatedAt : '',
    },
    usage: Array.isArray(value.usage)
      ? (value.usage.filter(isPlainObject) as unknown as HubSnapshot['usage'])
      : [],
  };
}

interface ImportPayload {
  database: Record<string, unknown>;
  hubs: Record<string, unknown>;
}

function readImportPayload(input: unknown): ImportPayload {
  if (!isPlainObject(input))
    throw new SpaceRpcError('space/invalid-input', '导入载荷必须是对象');
  const database = input.database;
  if (!isPlainObject(database))
    throw new SpaceRpcError('space/invalid-input', '缺少 database');
  if (database.version !== 1)
    throw new SpaceRpcError('space/invalid-input', '不支持的数据版本');
  const hubs = input.hubs;
  return { database, hubs: isPlainObject(hubs) ? hubs : {} };
}

/** Validate, de-duplicate and normalize the browser-local database. */
function buildImportData(
  payload: ImportPayload,
  now: () => Date,
): { database: SpaceStoreData; counts: Record<string, number> } {
  const at = now().toISOString();
  const spaces = collectEntities(payload.database.spaces);
  if (!spaces.some((space) => space.id === DEFAULT_SPACE_ID)) {
    spaces.unshift(defaultSpace(now()) as unknown as Record<string, unknown>);
  }
  const spaceIds = new Set(spaces.map((space) => String(space.id)));
  const nodes = filterBy(collectEntities(payload.database.nodes), 'spaceId', spaceIds);
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const comments = filterBy(collectEntities(payload.database.comments), 'docId', nodeIds);
  const versions = filterBy(collectEntities(payload.database.versions), 'docId', nodeIds);
  const thoughts = filterBy(
    collectEntities(payload.database.thoughts),
    'spaceId',
    spaceIds,
  );
  const agents = collectEntities(payload.database.agents);
  const tasks = filterBy(collectEntities(payload.database.tasks), 'spaceId', spaceIds);
  const events = filterBy(collectEntities(payload.database.events), 'spaceId', spaceIds);
  const milestones = filterBy(
    collectEntities(payload.database.milestones),
    'spaceId',
    spaceIds,
  );
  const hub: Record<string, HubSnapshot> = {};
  for (const spaceId of spaceIds) {
    const snapshot = payload.hubs[spaceId];
    if (snapshot !== undefined) hub[spaceId] = normalizeSnapshot(snapshot, at);
  }
  const collections = {
    spaces,
    nodes,
    thoughts,
    comments,
    versions,
    agents,
    tasks,
    events,
    milestones,
  };
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [name, items] of Object.entries(collections)) {
    counts[name] = items.length;
    total += items.length;
  }
  counts.hubs = Object.keys(hub).length;
  if (total > MAX_IMPORT_ENTITIES)
    throw new SpaceRpcError('space/payload-too-large', '导入数据量超过上限');
  const database = {
    version: 1,
    ...collections,
    hub,
  } as unknown as SpaceStoreData;
  return { database, counts };
}

/**
 * Create the RPC handler for one opened authority.
 * @param options - opened store, composed service and business clock.
 */
export function createSpaceRpc(options: SpaceRpcOptions): SpaceRpcHandler {
  const { store, service, now } = options;
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
      if (endpoint === 'migrate.import') {
        const importPayload = readImportPayload(args[0]);
        const { database, counts } = buildImportData(importPayload, now);
        const result = await store.importData(database);
        return {
          value:
            result.imported === true
              ? { imported: true, counts: result.counts }
              : { imported: false, reason: result.reason },
        };
      }
      if (group === 'space' && SPACE_METHOD_SET.has(method)) {
        const target = service as unknown as Record<
          string,
          (...callArgs: unknown[]) => unknown
        >;
        const value = await target[method](...args);
        return { value: value === undefined ? null : value };
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
      if (error instanceof SpaceRpcError)
        return { error: { code: error.code, message: error.message } };
      return {
        error: { code: 'space/failed', message: messageOf(error) },
      };
    }
  };
}
