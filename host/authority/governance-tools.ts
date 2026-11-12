/**
 * Model-facing Agent tools for Space governance and collaborators.
 *
 * Two tools share one registrar because they answer the same question — "what
 * does this Space installation look like, and how is it managed?":
 *
 * - `space_governance` creates, renames, archives, reorders and deletes spaces
 *   and empties their trash. Deleting a space or emptying a trash is
 *   irreversible (documents, versions, comments and thoughts go with it), so
 *   those two actions ask the user first and fail closed without an approval
 *   service.
 * - `space_collaborators` lists/creates the configured collaborators (agents)
 *   and browses directories before a space is bound to one.
 *
 * Both are thin adapters over authority endpoints bound to the `alter` identity
 * stack; read projections are bounded and never return raw authority records.
 *
 * @module @alter-dsh/space/authority/governance-tools
 */
import type { Agent, DirectoryListing, Space } from '@alter/protocol';
import type {
  JsonSchemaLike,
  ToolRunContextLike,
  ToolTextBlock,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import {
  approveDestructive,
  asRecord,
  invalid,
  optionalString,
  requireAction,
  requireString,
  requireStringArray,
  text,
  toToolError,
  type ErrorHint,
  type RpcCall,
  type RpcToolDeps,
} from './tool-support.js';

const GOVERNANCE_ACTIONS = [
  'create_space',
  'update_space',
  'archive_space',
  'unarchive_space',
  'delete_space',
  'reorder_spaces',
  'empty_trash',
] as const;

const COLLABORATOR_ACTIONS = [
  'list_agents',
  'create_agent',
  'list_directories',
] as const;

const AGENT_LIMIT = 100;
const DIRECTORY_LIMIT = 100;
const DEFAULT_AGENT_ROLE = 'collaborator';

/** Space projection shared by every governance result. */
interface SpaceMeta {
  id: string;
  name: string;
  goal: string;
  directories: string[];
  is_default: boolean;
  order: number;
  created_at: string;
  archived_at: string | null;
}

/** Collaborator projection; optional fields stay absent when unset. */
interface AgentMeta {
  id: string;
  name: string;
  role: string;
  description?: string;
  model?: string;
  permissions?: string[];
  created_at: string;
}

/** One directory entry projection. */
interface DirectoryEntryMeta {
  path: string;
  name: string;
}

/** Bounded directory listing projection. */
interface DirectoryListingMeta {
  path: string;
  total: number;
  truncated: boolean;
  entries: DirectoryEntryMeta[];
}

/** Vendor failures the model can resolve by changing the request. */
const GOVERNANCE_HINTS: readonly ErrorHint[] = [
  {
    match: '默认空间不能归档',
    hint: '默认空间不允许归档；请选择其他空间。',
  },
  {
    match: '默认空间不能删除',
    hint: '默认空间不允许删除；请选择其他空间。',
  },
];

const COLLABORATOR_HINTS: readonly ErrorHint[] = [
  {
    match: '目录不存在',
    hint: 'path 必须是绝对路径或以 ~ 开头的主目录路径，且目录可读；请传实际存在的目录。',
  },
  {
    match: '协作者名称不能为空',
    hint: 'create_agent 需要非空 name；请重新提供协作者名称。',
  },
];

/** Reason shown to the user before a whole space is destroyed. */
function deleteSpaceReason(spaceId: string): string {
  return `删除空间 ${spaceId} 会连同其全部文档、版本、评论、随想与事件一并永久移除，不可恢复；请确认后继续。`;
}

/** Reason shown to the user before the trash is purged. */
function emptyTrashReason(spaceId: string): string {
  return `清空空间 ${spaceId} 的回收站会永久删除其中全部节点、随想及其版本/评论，不可恢复；请确认后继续。`;
}

/** Permissive multi-action output shape, same convention as the other tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

function spaceMeta(space: Space): SpaceMeta {
  return {
    id: space.id,
    name: space.name,
    goal: space.goal,
    directories: space.directories,
    is_default: space.isDefault,
    order: space.order,
    created_at: space.createdAt,
    archived_at: space.archivedAt,
  };
}

function agentMeta(agent: Agent): AgentMeta {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    ...(agent.description === undefined
      ? {}
      : { description: agent.description }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.permissions === undefined
      ? {}
      : { permissions: agent.permissions }),
    created_at: agent.createdAt,
  };
}

function directoryListingMeta(
  listing: DirectoryListing,
): DirectoryListingMeta {
  return {
    path: listing.path,
    total: listing.entries.length,
    truncated: listing.entries.length > DIRECTORY_LIMIT,
    entries: listing.entries.slice(0, DIRECTORY_LIMIT).map((entry) => ({
      path: entry.path,
      name: entry.name,
    })),
  };
}

/** Read the `action` discriminator of a call before running it. */
function actionOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const action = (args as { action?: unknown }).action;
  return typeof action === 'string' ? action : '';
}

/**
 * Optional string array that still accepts an explicit empty array (an empty
 * `directories` list is a meaningful answer: this space owns no workspace).
 */
function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(`${key} 必须是字符串数组`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '')
      invalid(`${key} 的每一项都必须是非空字符串`);
    return entry.trim();
  });
}

function renderGovernance(args: unknown, value: unknown): ToolTextBlock[] {
  const action = actionOf(args);
  const result = value as {
    space?: SpaceMeta;
    spaces?: Array<{ id: string; name: string; order: number }>;
    space_id?: string;
    deleted?: boolean;
    emptied?: boolean;
  };
  if (Array.isArray(result.spaces)) {
    const spaces = result.spaces;
    return [
      text(
        [
          `空间顺序已更新，共 ${spaces.length} 个：`,
          ...spaces.map((space) => `- ${space.order}. ${space.name}（${space.id}）`),
        ].join('\n'),
      ),
    ];
  }
  if (result.deleted === true)
    return [
      text(
        `已删除空间 ${result.space_id ?? ''}（文档/版本/评论/随想一并移除，不可恢复）。`,
      ),
    ];
  if (result.emptied === true)
    return [text(`已清空空间 ${result.space_id ?? ''} 的回收站（不可恢复）。`)];
  const space = result.space;
  if (space === undefined) return [text(JSON.stringify(value))];
  const verbs: Record<string, string> = {
    create_space: '已创建空间',
    update_space: '已更新空间',
    archive_space: '已归档空间',
    unarchive_space: '已取消归档',
  };
  const goal = space.goal === '' ? '' : `，目标：${space.goal}`;
  return [
    text(
      `${verbs[action] ?? '已更新空间'} ${space.id}《${space.name}》${goal}（directories ${space.directories.length} 个）。`,
    ),
  ];
}

function renderCollaborators(_args: unknown, value: unknown): ToolTextBlock[] {
  const result = value as {
    agents?: AgentMeta[];
    total?: number;
    truncated?: boolean;
    agent?: AgentMeta;
    path?: string;
    entries?: DirectoryEntryMeta[];
  };
  if (Array.isArray(result.agents)) {
    const agents = result.agents;
    const header = `共 ${String(result.total ?? agents.length)} 个协作者${
      result.truncated === true ? `，仅返回前 ${agents.length} 个（truncated）` : ''
    }`;
    const lines = agents.map((agent) => {
      const model = agent.model === undefined ? '' : `，模型 ${agent.model}`;
      return `- ${agent.id} ${agent.name}（${agent.role || '未填写职责'}${model}）`;
    });
    return [
      text(
        [header, ...lines, agents.length === 0 ? '（没有协作者）' : '']
          .filter(Boolean)
          .join('\n'),
      ),
    ];
  }
  const agent = result.agent;
  if (agent !== undefined)
    return [
      text(
        `已创建协作者 ${agent.id}《${agent.name}》，职责：${agent.role || '未填写'}。`,
      ),
    ];
  if (Array.isArray(result.entries)) {
    const entries = result.entries;
    const header = `目录 ${result.path ?? ''}：共 ${String(result.total ?? entries.length)} 个子目录${
      result.truncated === true
        ? `，仅返回前 ${entries.length} 个（truncated）`
        : ''
    }`;
    return [
      text(
        [header, ...entries.map((entry) => `- ${entry.name}（${entry.path}）`)]
          .filter(Boolean)
          .join('\n') || '（没有子目录）',
      ),
    ];
  }
  return [text(JSON.stringify(value))];
}

/**
 * Read an optional string while preserving an explicit empty value.
 *
 * `goal: ''` is how the model clears a space goal, so it must survive argument
 * validation instead of collapsing into "absent".
 */
function readOptionalTrimmedString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${key} 必须是字符串`);
  return value.trim();
}

/** One governance action over the alter-bound endpoint caller. */
async function runGovernance(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
  exec: ToolRunContextLike,
): Promise<unknown> {
  const action = requireAction(input, GOVERNANCE_ACTIONS);
  const spaceId = optionalString(input, 'space_id');
  const needSpaceId = (): string => {
    if (spaceId === undefined || spaceId === '')
      invalid(
        `action=${action} 需要 space_id；请先用 space_browse spaces 获取`,
      );
    return spaceId;
  };

  switch (action) {
    case 'create_space': {
      const name = requireString(input, 'name');
      const goal = optionalString(input, 'goal');
      const directories = optionalStringArray(input, 'directories');
      const space = (await deps.rpc('space.createSpace', [
        {
          name,
          ...(goal === undefined ? {} : { goal }),
          ...(directories === undefined ? {} : { directories }),
        },
      ])) as Space;
      return { space: spaceMeta(space) };
    }
    case 'update_space': {
      const name = optionalString(input, 'name');
      const goal = readOptionalTrimmedString(input, 'goal');
      if (name === undefined && goal === undefined)
        invalid('action=update_space 需要至少提供 name 或 goal');
      const patch = {
        ...(name === undefined ? {} : { name }),
        ...(goal === undefined ? {} : { goal }),
      };
      const space = (await deps.rpc('space.updateSpace', [
        needSpaceId(),
        patch,
      ])) as Space;
      return { space: spaceMeta(space) };
    }
    case 'archive_space':
    case 'unarchive_space': {
      const endpoint =
        action === 'archive_space' ? 'space.archiveSpace' : 'space.unarchiveSpace';
      const space = (await deps.rpc(endpoint, [needSpaceId()])) as Space;
      return { space: spaceMeta(space) };
    }
    case 'delete_space': {
      const id = needSpaceId();
      await approveDestructive(deps, exec, deleteSpaceReason(id));
      await deps.rpc('space.deleteSpace', [id]);
      return { deleted: true, space_id: id };
    }
    case 'reorder_spaces': {
      const ids = requireStringArray(input, 'space_ids');
      const spaces = (await deps.rpc('space.reorderSpaces', [ids])) as Space[];
      return {
        spaces: spaces.map((space) => ({
          id: space.id,
          name: space.name,
          order: space.order,
        })),
      };
    }
    case 'empty_trash': {
      const id = needSpaceId();
      await approveDestructive(deps, exec, emptyTrashReason(id));
      await deps.rpc('space.emptyTrash', [id]);
      return { emptied: true, space_id: id };
    }
  }
}

/** One collaborator action over the alter-bound endpoint caller. */
async function runCollaborator(
  rpc: RpcCall,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = requireAction(input, COLLABORATOR_ACTIONS);

  switch (action) {
    case 'list_agents': {
      const agents = (await rpc('space.listAgents', [])) as Agent[];
      return {
        total: agents.length,
        truncated: agents.length > AGENT_LIMIT,
        agents: agents.slice(0, AGENT_LIMIT).map(agentMeta),
      };
    }
    case 'create_agent': {
      const name = requireString(input, 'name');
      const role = optionalString(input, 'role') ?? DEFAULT_AGENT_ROLE;
      const description = optionalString(input, 'description');
      const model = optionalString(input, 'model');
      const agent = (await rpc('space.createAgent', [
        {
          name,
          role,
          ...(description === undefined ? {} : { description }),
          ...(model === undefined ? {} : { model }),
        },
      ])) as Agent;
      return { agent: agentMeta(agent) };
    }
    case 'list_directories': {
      const listing = (await rpc('space.listDirectories', [
        requireString(input, 'path'),
      ])) as DirectoryListing;
      return directoryListingMeta(listing);
    }
  }
}

/**
 * Register the Space governance and collaborator tools on one Host tools
 * service.
 * @param tools - Host tools service.
 * @param deps - alter-bound endpoint caller plus the approval resolver used by
 *   the irreversible `delete_space` / `empty_trash` actions.
 * @returns disposer that removes both registrations.
 */
export function registerGovernanceTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: 'space_governance',
      description:
        'Govern spaces themselves: create a space (optionally with a goal and working directories), rename it or change its goal, archive/unarchive, reorder, delete a space or empty its trash. delete_space and empty_trash are irreversible and require user approval; without an approval service they fail closed. Reads live in space_browse.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...GOVERNANCE_ACTIONS],
            description: 'Governance change to apply.',
          },
          space_id: {
            type: 'string',
            description:
              'Target space; required for update/archive/unarchive/delete/empty_trash.',
          },
          name: {
            type: 'string',
            description: 'create_space: new name (required). update_space: new name.',
          },
          goal: {
            type: 'string',
            description:
              'create_space/update_space: goal text; an empty string clears the goal.',
          },
          directories: {
            type: 'array',
            items: { type: 'string' },
            description:
              'create_space: main working directories; directories[0] becomes the workspace.',
          },
          space_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'reorder_spaces: every space id, in the desired order.',
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (args, value) => renderGovernance(args, value),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          return await runGovernance(deps, asRecord(args), exec);
        } catch (error) {
          throw toToolError(error, GOVERNANCE_HINTS);
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Space governance',
        kind: 'edit',
      }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_collaborators',
      description:
        'Browse collaborators and directories: list the configured collaborators (agents), create one with a name and responsibility, or list the subdirectories of a path before binding a space to it. Reads do not change state.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...COLLABORATOR_ACTIONS],
            description: 'Collaborator operation to run.',
          },
          name: {
            type: 'string',
            description: 'create_agent: collaborator name (required).',
          },
          role: {
            type: 'string',
            description:
              "create_agent: responsibilities; defaults to 'collaborator'.",
          },
          description: {
            type: 'string',
            description: 'create_agent: what this collaborator is good at.',
          },
          model: {
            type: 'string',
            description: 'create_agent: preferred model label.',
          },
          path: {
            type: 'string',
            description:
              'list_directories: absolute path or ~-prefixed home path (required).',
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (args, value) => renderCollaborators(args, value),
      },
      isConcurrencySafe: (args) => {
        const action = actionOf(args);
        return action === 'list_agents' || action === 'list_directories';
      },
      async execute(args) {
        try {
          return await runCollaborator(deps.rpc, asRecord(args));
        } catch (error) {
          throw toToolError(error, COLLABORATOR_HINTS);
        }
      },
      presentCall: (args) => {
        const action = actionOf(args);
        return {
          card: 'generic',
          title: 'Space collaborators',
          kind:
            action === 'list_agents' || action === 'list_directories'
              ? 'read'
              : 'edit',
        };
      },
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}