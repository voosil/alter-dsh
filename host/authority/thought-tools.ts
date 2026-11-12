/**
 * Model-facing Agent tools for Space thoughts (quick captured ideas).
 *
 * Thoughts are a separate entity from documents: they hold plain text, can be
 * archived, moved between spaces, soft-deleted into the trash and converted
 * into a new document. This module is a thin adapter over the authority
 * endpoints bound to the `alter` identity stack — it never re-implements
 * persistence, and every write is attributed to Alter by the authority.
 *
 * Read projections are bounded (`content` is clipped, the list is capped) so a
 * chatty space can never blow up the model context.
 *
 * @module @alter-dsh/space/authority/thought-tools
 */
import type { Thought } from '@alter/protocol';
import type {
  JsonSchemaLike,
  ToolTextBlock,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import {
  asRecord,
  clip,
  invalid,
  optionalBoolean,
  optionalString,
  requireAction,
  requireBoolean,
  requireString,
  text,
  toToolError,
  type ErrorHint,
  type RpcCall,
  type RpcToolDeps,
} from './tool-support.js';

const THOUGHT_ACTIONS = [
  'list',
  'create',
  'update',
  'archive',
  'delete',
  'restore',
  'move',
  'convert',
] as const;

const LIST_LIMIT = 50;
const CONTENT_PREVIEW_MAX = 200;

/** Fixed thought projection; raw text never exceeds the preview budget. */
interface ThoughtMeta {
  id: string;
  space_id: string;
  creator: string;
  content: string;
  archived: boolean;
  converted_doc_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The `convert` endpoint answers with the converted thought plus a new node. */
interface ConvertResult {
  thought: Thought;
  node: { id: string; title: string };
}

/** Vendor failure the model can resolve by re-reading the list. */
const THOUGHT_HINTS: readonly ErrorHint[] = [
  {
    match: '随想不存在',
    hint: '随想 id 不存在或已被永久删除；请先用 space_thoughts list（回收站见 space_browse trash）重新定位。',
  },
  {
    match: '这条随想已经转为文档',
    hint: '该随想已转换过；请直接编辑其文档，或先创建一条新随想。',
  },
];

/** Permissive multi-action output shape, same convention as the other tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

function thoughtMeta(thought: Thought): ThoughtMeta {
  return {
    id: thought.id,
    space_id: thought.spaceId,
    creator: thought.creator,
    content: clip(thought.content, CONTENT_PREVIEW_MAX),
    archived: thought.archived,
    converted_doc_id: thought.convertedDocId,
    created_at: thought.createdAt,
    updated_at: thought.updatedAt,
  };
}

/** Read the `action` discriminator of a call before running it. */
function actionOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const action = (args as { action?: unknown }).action;
  return typeof action === 'string' ? action : '';
}

function renderThoughts(args: unknown, value: unknown): ToolTextBlock[] {
  const action = actionOf(args);
  const result = value as {
    space_id?: string;
    total?: number;
    truncated?: boolean;
    thoughts?: ThoughtMeta[];
    thought?: ThoughtMeta;
    thought_id?: string;
    target_space_id?: string;
    deleted?: boolean;
    doc_id?: string;
    title?: string;
  };
  if (Array.isArray(result.thoughts)) {
    const thoughts = result.thoughts;
    const header = `空间 ${result.space_id ?? ''}：共 ${String(result.total ?? thoughts.length)} 条随想${
      result.truncated === true
        ? `，仅返回前 ${thoughts.length} 条（truncated）`
        : ''
    }`;
    const lines = thoughts.map((thought) => {
      const owner = thought.creator === 'alter' ? ' · Alter' : '';
      const flags = thought.archived ? '（已归档）' : '';
      return `- ${thought.id} ${thought.content}${owner}${flags}`;
    });
    return [
      text(
        [header, ...lines, thoughts.length === 0 ? '（没有随想）' : '']
          .filter(Boolean)
          .join('\n'),
      ),
    ];
  }
  if (result.deleted === true)
    return [
      text(
        `已删除随想 ${result.thought_id ?? ''}（进回收站）；可用 space_thoughts restore 恢复。`,
      ),
    ];
  if (action === 'convert' && result.doc_id !== undefined)
    return [
      text(
        `已把随想 ${result.thought?.id ?? ''} 转为文档 ${result.doc_id}《${result.title ?? ''}》；正文用 space_doc_read / space_doc_ops 写入。`,
      ),
    ];
  const thought = result.thought;
  if (thought === undefined) return [text(JSON.stringify(value))];
  const verbs: Record<string, string> = {
    create: '已创建随想',
    update: '已更新随想',
    archive: thought.archived ? '已归档随想' : '已取消归档随想',
    restore: '已恢复随想',
    move: `已把随想 ${thought.id} 移到空间 ${result.target_space_id ?? thought.space_id}`,
  };
  return [text(`${verbs[action] ?? '已更新随想'} ${thought.id}：${thought.content}`)];
}

/** One thought action over the alter-bound endpoint caller. */
async function runThought(
  rpc: RpcCall,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = requireAction(input, THOUGHT_ACTIONS);
  const thoughtId = optionalString(input, 'thought_id');
  const needThoughtId = (): string => {
    if (thoughtId === undefined || thoughtId === '')
      invalid(`action=${action} 需要 thought_id；请先用 list 获取随想 id`);
    return thoughtId;
  };

  switch (action) {
    case 'list': {
      const spaceId = requireString(input, 'space_id');
      const includeArchived = optionalBoolean(input, 'include_archived');
      const thoughts = (await rpc('space.listThoughts', [
        spaceId,
        includeArchived === undefined ? {} : { includeArchived },
      ])) as Thought[];
      const total = thoughts.length;
      return {
        space_id: spaceId,
        total,
        truncated: total > LIST_LIMIT,
        thoughts: thoughts.slice(0, LIST_LIMIT).map(thoughtMeta),
      };
    }
    case 'create': {
      const thought = (await rpc('space.createThought', [
        {
          spaceId: requireString(input, 'space_id'),
          content: requireString(input, 'content'),
        },
      ])) as Thought;
      return { thought: thoughtMeta(thought) };
    }
    case 'update': {
      const thought = (await rpc('space.updateThought', [
        needThoughtId(),
        requireString(input, 'content'),
      ])) as Thought;
      return { thought: thoughtMeta(thought) };
    }
    case 'archive': {
      const thought = (await rpc('space.setThoughtArchived', [
        needThoughtId(),
        requireBoolean(input, 'archived'),
      ])) as Thought;
      return { thought: thoughtMeta(thought) };
    }
    case 'delete': {
      const id = needThoughtId();
      await rpc('space.deleteThought', [id]);
      return { deleted: true, thought_id: id };
    }
    case 'restore': {
      const thought = (await rpc('space.restoreThought', [
        needThoughtId(),
      ])) as Thought;
      return { thought: thoughtMeta(thought) };
    }
    case 'move': {
      const id = needThoughtId();
      const targetSpaceId = requireString(input, 'target_space_id');
      const thought = (await rpc('space.moveThought', [
        id,
        targetSpaceId,
      ])) as Thought;
      return { thought: thoughtMeta(thought), target_space_id: targetSpaceId };
    }
    case 'convert': {
      const result = (await rpc('space.convertThought', [
        needThoughtId(),
      ])) as ConvertResult;
      return {
        thought: thoughtMeta(result.thought),
        doc_id: result.node.id,
        title: result.node.title,
      };
    }
  }
}

/**
 * Register the Space thoughts tool on one Host tools service.
 * @param tools - Host tools service.
 * @param deps - alter-bound endpoint caller (the approval resolver is unused:
 *   every thought action is reversible or soft-delete only).
 * @returns disposer that removes the registration.
 */
export function registerThoughtTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposer = tools.register({
    name: 'space_thoughts',
    description:
      'Manage Space thoughts (quick captured ideas): list by space, create, update text, archive/unarchive, soft-delete into the trash and restore, move between spaces, or convert one into a new document. Writes are attributed to Alter; write the converted document body with space_doc_generate/space_doc_ops.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...THOUGHT_ACTIONS],
          description: 'Thought operation to run.',
        },
        space_id: {
          type: 'string',
          description: 'list/create: target space (required).',
        },
        thought_id: {
          type: 'string',
          description:
            'Target thought; required for every action except list/create.',
        },
        content: {
          type: 'string',
          description: 'create/update: thought text (required).',
        },
        archived: {
          type: 'boolean',
          description: 'archive: target archived state (required).',
        },
        target_space_id: {
          type: 'string',
          description: 'move: destination space (required).',
        },
        include_archived: {
          type: 'boolean',
          description: 'list: include archived thoughts. Defaults to false.',
        },
      },
    },
    output: {
      schema: outputSchema,
      render: (args, value) => renderThoughts(args, value),
    },
    isConcurrencySafe: (args) => actionOf(args) === 'list',
    async execute(args) {
      try {
        return await runThought(deps.rpc, asRecord(args));
      } catch (error) {
        throw toToolError(error, THOUGHT_HINTS);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Space thoughts',
      kind: actionOf(args) === 'list' ? 'read' : 'edit',
    }),
  });

  return () => disposer();
}