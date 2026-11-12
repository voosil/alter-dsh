/**
 * Model-facing Agent tools for Space discovery and node structure.
 *
 * `space_browse` projects metadata only (never document bodies) and never
 * touches activity/unread state; `space_tree` performs node lifecycle writes
 * bound to the `alter` authority stack. DSH's tool framework validates only
 * JSON syntax, so every argument is checked here and failures carry stable
 * error codes plus the next actionable step.
 *
 * @module @alter-dsh/space/authority/space-tools
 */
import type {
  Space,
  SpaceNode,
  SpaceOverview,
  Thought,
} from '@alter/protocol';
import type { SpaceToolApi } from '../core/backend.js';
import type {
  JsonSchemaLike,
  ToolTextBlock,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import {
  asRecord,
  clip,
  invalid,
  notFound,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireAction,
  requireBoolean,
  requireString,
  text,
  toToolError,
} from './tool-support.js';

/** Dependencies for the Space structure tools. */
export interface SpaceToolDeps {
  /** Alter-bound structure port (local stack or the bridge's stamped port). */
  service: SpaceToolApi;
}

/** Fixed node metadata projection; document bodies never cross this boundary. */
interface NodeMeta {
  id: string;
  kind: string;
  title: string;
  parent_id: string | null;
  pinned: boolean;
  archived: boolean;
  creator: string;
  updated_at: string;
}

/** Space metadata projection shared by the listing actions. */
interface SpaceMeta {
  id: string;
  name: string;
  goal: string;
  directories: string[];
  is_default: boolean;
  order: number;
}

const TREE_LIMIT = 500;
const SEARCH_DEFAULT = 20;
const SEARCH_MAX = 50;
const EXCERPT_MAX = 60;
const THOUGHT_PREVIEW_MAX = 80;
const OVERVIEW_DOCS_MAX = 10;
const OVERVIEW_EVENTS_MAX = 20;
const OVERVIEW_ITEMS_MAX = 20;

const BROWSE_ACTIONS = [
  'spaces',
  'archived_spaces',
  'space',
  'tree',
  'node',
  'overview',
  'search',
  'trash',
] as const;

const TREE_ACTIONS = [
  'create',
  'rename',
  'move',
  'pin',
  'archive',
  'delete',
  'restore',
] as const;

/** A parent reference: an id, or explicit null for the space root. */
function optionalParentId(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '')
    invalid(`${key} 必须是节点 id 字符串或 null（根目录）`);
  return value;
}

function requireParentId(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = optionalParentId(args, key);
  if (value === undefined) invalid(`${key} 必填：节点 id 字符串或 null（根目录）`);
  return value;
}

function requireKind(args: Record<string, unknown>): 'folder' | 'note' {
  const value = args.kind;
  if (value !== 'folder' && value !== 'note')
    invalid("kind 必须是 'folder' 或 'note'");
  return value;
}

function nodeMeta(node: SpaceNode): NodeMeta {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    parent_id: node.parentId,
    pinned: node.pinned,
    archived: node.archived,
    creator: node.creator,
    updated_at: node.updatedAt,
  };
}

function spaceMeta(space: Space): SpaceMeta {
  return {
    id: space.id,
    name: space.name,
    goal: space.goal,
    directories: space.directories,
    is_default: space.isDefault,
    order: space.order,
  };
}

/**
 * Existence pre-check: ids are resolved against the authority, never trusted.
 * The local port answers `undefined` for missing entities while the server
 * port answers `null` (the RPC envelope normalizes undefined), so both mean
 * "not found" here.
 */
async function requireSpace(
  service: SpaceToolApi,
  spaceId: string,
): Promise<Space> {
  const space = (await service.getSpace(spaceId)) as Space | null | undefined;
  if (space === undefined || space === null)
    notFound(`空间 ${spaceId} 不存在；请先用 space_browse spaces 列出可用空间`);
  return space;
}

async function requireNode(
  service: SpaceToolApi,
  nodeId: string,
): Promise<SpaceNode> {
  const node = (await service.getNode(nodeId)) as SpaceNode | null | undefined;
  if (node === undefined || node === null)
    notFound(
      `节点 ${nodeId} 不存在或已删除；请先用 space_browse tree 定位（已删除节点见 trash）`,
    );
  return node;
}

function renderNodeLine(node: NodeMeta): string {
  // The structured projection always carries `creator`, but the text rendered
  // to the model drops it. Mark Alter-created nodes so the Agent can tell its
  // own documents from the user's without a per-node `action=node` lookup.
  const owner = node.creator === 'alter' ? ' · Alter' : '';
  const flags = `${node.pinned ? ' 📌' : ''}${node.archived ? '（已归档）' : ''}`;
  const parent = node.parent_id === null ? '' : ` ← ${node.parent_id}`;
  return `- ${node.id} [${node.kind}] ${node.title || '（未命名）'}${owner}${parent}${flags}`;
}

function renderBrowse(value: unknown): ToolTextBlock[] {
  const result = value as Record<string, unknown>;
  if (Array.isArray(result.spaces)) {
    const spaces = result.spaces as SpaceMeta[];
    return [
      text(
        spaces.length === 0
          ? '（没有空间）'
          : spaces.map((space) => `- ${space.id} ${space.name}`).join('\n'),
      ),
    ];
  }
  if (Array.isArray(result.nodes) && typeof result.total === 'number') {
    const nodes = result.nodes as NodeMeta[];
    const header = `空间 ${String(result.space_id)}：共 ${result.total} 个节点${
      result.truncated === true ? `，仅返回前 ${nodes.length} 个（truncated）` : ''
    }`;
    return [text([header, ...nodes.map(renderNodeLine)].join('\n'))];
  }
  if (Array.isArray(result.hits)) {
    const hits = result.hits as Array<{
      id: string;
      type: string;
      title: string;
      excerpt: string;
    }>;
    const lines = hits.map(
      (hit) => `- ${hit.id} [${hit.type}] ${hit.title}：${hit.excerpt}`,
    );
    return [
      text(
        [...lines, result.truncated === true ? '(truncated)' : '']
          .filter(Boolean)
          .join('\n') || '没有命中',
      ),
    ];
  }
  if (Array.isArray(result.thoughts)) {
    const nodes = (result.nodes ?? []) as NodeMeta[];
    const thoughts = result.thoughts as Array<{
      id: string;
      content_preview: string;
    }>;
    return [
      text(
        [
          ...nodes.map(renderNodeLine),
          ...thoughts.map((thought) => `- ${thought.id} [随想] ${thought.content_preview}`),
        ].join('\n') || '回收站为空',
      ),
    ];
  }
  return [text(JSON.stringify(value, null, 2))];
}

function renderTree(args: unknown, value: unknown): ToolTextBlock[] {
  const input = args as { action?: string };
  const result = value as {
    node?: NodeMeta;
    deleted?: boolean;
    node_id?: string;
  };
  if (result.deleted === true)
    return [
      text(
        `已软删除节点 ${String(result.node_id)}（进回收站）；可用 space_tree restore 恢复。`,
      ),
    ];
  const node = result.node;
  if (node === undefined) return [text(JSON.stringify(value))];
  const verbs: Record<string, string> = {
    create: '已创建',
    rename: '已改名',
    move: '已移动',
    pin: '已更新置顶',
    archive: '已更新归档',
    restore: '已恢复',
  };
  const verb = verbs[input.action ?? ''] ?? '已更新';
  return [
    text(`${verb}节点 ${node.id}《${node.title || '未命名'}》[${node.kind}]。`),
  ];
}

/** Permissive multi-action output shape, same convention as the control tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

/** Read projections over the alter-bound structure port. */
async function browse(
  service: SpaceToolApi,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = requireAction(input, BROWSE_ACTIONS);
  const spaceId = optionalString(input, 'space_id');
  const nodeId = optionalString(input, 'node_id');
  const query = optionalString(input, 'query');
  const includeArchived = optionalBoolean(input, 'include_archived');
  const limit = optionalInteger(input, 'limit', { min: 1, max: SEARCH_MAX });

  const needSpaceId = (): string => {
    if (spaceId === undefined || spaceId.trim() === '')
      invalid(`action=${action} 需要 space_id；请先用 space_browse spaces 获取`);
    return spaceId;
  };

  switch (action) {
    case 'spaces':
      return { spaces: (await service.listSpaces()).map(spaceMeta) };
    case 'archived_spaces':
      return { spaces: (await service.listArchivedSpaces()).map(spaceMeta) };
    case 'space': {
      const id = needSpaceId();
      return spaceMeta(await requireSpace(service, id));
    }
    case 'tree': {
      const id = needSpaceId();
      await requireSpace(service, id);
      const nodes = (await service.listNodes(id)).filter(
        (node) =>
          node.deletedAt === null &&
          (includeArchived === true || !node.archived),
      );
      const total = nodes.length;
      return {
        space_id: id,
        total,
        truncated: total > TREE_LIMIT,
        nodes: nodes.slice(0, TREE_LIMIT).map(nodeMeta),
      };
    }
    case 'node': {
      if (nodeId === undefined || nodeId.trim() === '')
        invalid('action=node 需要 node_id；请先用 space_browse tree 或 search 获取');
      return nodeMeta(await requireNode(service, nodeId));
    }
    case 'overview': {
      const id = needSpaceId();
      await requireSpace(service, id);
      const overview: SpaceOverview = await service.getOverview(id);
      const days = overview.activity;
      const latest = days.length === 0 ? undefined : days[days.length - 1];
      return {
        space_id: id,
        recent_docs: overview.recentDocs
          .slice(0, OVERVIEW_DOCS_MAX)
          .map(nodeMeta),
        activity: {
          active_days: days.length,
          total_events: days.reduce((sum, day) => sum + day.count, 0),
          latest:
            latest === undefined
              ? null
              : { date: latest.date, count: latest.count },
        },
        agent_events: overview.agentEvents
          .slice(0, OVERVIEW_EVENTS_MAX)
          .map((event) => ({
            id: event.id,
            title: event.title,
            at: event.at,
            source: event.source,
            doc_id: event.docId,
          })),
        tasks: overview.tasks.slice(0, OVERVIEW_ITEMS_MAX).map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          owner: task.owner,
          doc_id: task.docId,
        })),
        milestones: overview.milestones
          .slice(0, OVERVIEW_ITEMS_MAX)
          .map((milestone) => ({
            id: milestone.id,
            title: milestone.title,
            status: milestone.status,
            period: milestone.period,
          })),
      };
    }
    case 'search': {
      const id = needSpaceId();
      if (query === undefined || query.trim() === '')
        invalid('action=search 需要非空 query');
      await requireSpace(service, id);
      const hits = await service.search(id, query);
      const max = limit ?? SEARCH_DEFAULT;
      return {
        query,
        truncated: hits.length > max,
        hits: hits.slice(0, max).map((hit) => ({
          id: hit.id,
          type: hit.type,
          space_id: hit.spaceId,
          title: hit.title,
          excerpt: clip(hit.excerpt, EXCERPT_MAX),
          creator: hit.creator,
        })),
      };
    }
    case 'trash': {
      const id = needSpaceId();
      await requireSpace(service, id);
      const deleted = await service.listDeleted(id);
      return {
        space_id: id,
        nodes: deleted.nodes.map(nodeMeta),
        thoughts: deleted.thoughts.map((thought: Thought) => ({
          id: thought.id,
          content_preview: clip(thought.content, THOUGHT_PREVIEW_MAX),
          created_at: thought.createdAt,
          creator: thought.creator,
        })),
      };
    }
  }
}

/** Node lifecycle writes over the alter-bound structure port. */
async function tree(
  service: SpaceToolApi,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = requireAction(input, TREE_ACTIONS);
  const nodeId = optionalString(input, 'node_id');
  const needNodeId = (): string => {
    if (nodeId === undefined || nodeId.trim() === '')
      invalid(`action=${action} 需要 node_id；请先用 space_browse tree 获取`);
    return nodeId;
  };

  switch (action) {
    case 'create': {
      const spaceId = requireString(input, 'space_id');
      const kind = requireKind(input);
      const title = optionalString(input, 'title');
      const parentId = optionalParentId(input, 'parent_id') ?? null;
      if (kind === 'folder' && parentId !== null)
        invalid('文件夹只能创建在根目录：请省略 parent_id');
      await requireSpace(service, spaceId);
      if (parentId !== null) {
        const parent = await requireNode(service, parentId);
        if (parent.spaceId !== spaceId)
          invalid('上级目录不属于当前空间；请用 space_browse tree 重新定位');
      }
      const node = await service.createNode({
        spaceId,
        kind,
        ...(title === undefined ? {} : { title }),
        ...(parentId === null ? {} : { parentId }),
      });
      return { node: nodeMeta(node) };
    }
    case 'rename': {
      if ('content' in input)
        invalid(
          'rename 只改元数据，不接受 content；正文写入请用 space_doc_ops 或 space_doc_generate',
        );
      const id = needNodeId();
      const title = requireString(input, 'title');
      await requireNode(service, id);
      return { node: nodeMeta(await service.saveNode(id, { title })) };
    }
    case 'move': {
      const id = needNodeId();
      const parentId = requireParentId(input, 'parent_id');
      const order = optionalInteger(input, 'order');
      const node = await requireNode(service, id);
      const spaceId = optionalString(input, 'space_id') ?? node.spaceId;
      if (node.kind === 'folder' && parentId !== null)
        invalid('文件夹只能位于根目录：parent_id 必须为 null');
      await requireSpace(service, spaceId);
      if (parentId !== null) {
        const parent = await requireNode(service, parentId);
        if (parent.spaceId !== spaceId)
          invalid('目标位置不属于目标空间；请用 space_browse tree 重新定位');
      }
      const moved = await service.moveNode(id, {
        spaceId,
        parentId,
        ...(order === undefined ? {} : { order }),
      });
      return { node: nodeMeta(moved) };
    }
    case 'pin': {
      const id = needNodeId();
      const pinned = requireBoolean(input, 'pinned');
      await requireNode(service, id);
      return { node: nodeMeta(await service.setPinned(id, pinned)) };
    }
    case 'archive': {
      const id = needNodeId();
      const archived = requireBoolean(input, 'archived');
      await requireNode(service, id);
      return { node: nodeMeta(await service.setArchived(id, archived)) };
    }
    case 'delete': {
      const id = needNodeId();
      await requireNode(service, id);
      await service.deleteNode(id);
      return { deleted: true, node_id: id };
    }
    case 'restore': {
      const id = needNodeId();
      // Deleted nodes are invisible to getNode; the service resolves them and
      // its existence failure maps to space/not-found in toolError.
      return { node: nodeMeta(await service.restoreNode(id)) };
    }
  }
}

/**
 * Register the Space structure tools on one Host tools service.
 * @returns disposer that removes every registration.
 */
export function registerSpaceTools(
  tools: ToolsLike,
  deps: SpaceToolDeps,
): () => void {
  const disposers: Array<() => void> = [];
  const { service } = deps;

  disposers.push(
    tools.register({
      name: 'space_browse',
      description:
        'Browse Space structure: spaces, one space\'s node tree, node metadata, overview, search or trash. Returns metadata projections only, never document bodies — read content with space_doc_read. Reads do not change activity or unread state.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...BROWSE_ACTIONS],
            description: 'Projection to read.',
          },
          space_id: {
            type: 'string',
            description:
              'Required for space/tree/overview/search/trash; from spaces.',
          },
          node_id: {
            type: 'string',
            description: 'Required for node; from tree or search.',
          },
          query: {
            type: 'string',
            description: 'Required for search; text to find.',
          },
          include_archived: {
            type: 'boolean',
            description: 'tree: include archived nodes. Defaults to false.',
          },
          limit: {
            type: 'integer',
            description: 'search: maximum hits, 1-50, defaults to 20.',
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (_args, value) => renderBrowse(value),
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const input = asRecord(args);
          return await browse(service, input);
        } catch (error) {
          throw toToolError(error);
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Browse Space',
        kind: 'read',
      }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_tree',
      description:
        'Manage the Space node tree: create folders and empty notes, rename, move, pin, archive, soft-delete and restore nodes. Writes are attributed to Alter; delete goes to the trash and restore recovers it. Write document bodies with space_doc_generate/space_doc_ops, never here.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...TREE_ACTIONS],
            description: 'Structure change to apply.',
          },
          space_id: {
            type: 'string',
            description:
              'create: target space (required). move: destination space, defaults to the node\'s current space.',
          },
          node_id: {
            type: 'string',
            description: 'Target node; required for every action except create.',
          },
          kind: {
            type: 'string',
            enum: ['folder', 'note'],
            description:
              'create: node kind (required). A note starts empty; write its body with space_doc_generate/space_doc_ops.',
          },
          title: {
            type: 'string',
            description: 'rename: new title (required). create: optional title.',
          },
          parent_id: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'move: destination folder id, null for root (required). create: parent folder; folders must stay at root.',
          },
          pinned: {
            type: 'boolean',
            description: 'pin: target state (required).',
          },
          archived: {
            type: 'boolean',
            description: 'archive: target state (required).',
          },
          order: {
            type: 'integer',
            description: 'move: optional sort order among siblings.',
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (args, value) => renderTree(args, value),
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const input = asRecord(args);
          return await tree(service, input);
        } catch (error) {
          throw toToolError(error);
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Update Space tree',
        kind: 'edit',
      }),
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}