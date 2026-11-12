/**
 * Model-facing Agent tools for Space document comments.
 *
 * `space_comments` exposes the comment lifecycle (list/add/update/supplement/
 * resolve/delete) over the alter-bound authority RPC seam. Every argument is
 * checked here because DSH only validates JSON syntax, reads project a bounded
 * view instead of the raw rows (body/quote clipped, list capped) and the soft
 * delete is destructive: it needs explicit approval and fails closed when the
 * host has no approval service.
 *
 * @module @alter-dsh/space/authority/comment-tools
 */
import type { Comment, CommentAnchor } from '@alter/protocol';
import type {
  JsonSchemaLike,
  ToolRunContextLike,
  ToolTextBlock,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import type { ErrorHint, RpcToolDeps } from './tool-support.js';
import {
  approveDestructive,
  asRecord,
  clip,
  invalid,
  requireAction,
  requireString,
  text,
  toToolError,
} from './tool-support.js';

const COMMENT_ACTIONS = [
  'list',
  'add',
  'update',
  'supplement',
  'delete',
  'resolve',
] as const;

type CommentAction = (typeof COMMENT_ACTIONS)[number];

/** A read of one document never returns more than this many comments. */
const LIST_LIMIT = 50;
/** Bounded preview of free text (body and quote) in every projection. */
const PREVIEW_MAX = 300;

/** Tool-layer hints for vendor rejections a re-read of the target resolves. */
const COMMENT_HINTS: readonly ErrorHint[] = [
  {
    match: '评论不存在',
    hint: '请先用 space_comments list 查看该文档的评论 id 后重试。',
  },
  {
    match: '评论已解决',
    hint: '评论已是 resolved 状态，重复 resolve 不需要。',
  },
];

/** Comment anchor in its tool (snake_case) shape. */
interface AnchorView {
  block_id: string;
  offset: number;
  length: number;
}

/** Bounded projection of one comment; raw rows never cross this boundary. */
interface CommentView {
  id: string;
  doc_id: string;
  author: string;
  body: string;
  quote: string | null;
  anchor: AnchorView | null;
  status: string;
  supplements_count: number;
  created_at: string;
  resolved_at: string | null;
  deleted_at: string | null;
  edited_at: string | null;
}

/** Permissive multi-action output shape, same convention as the other tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

/** Read one `anchor` argument in the tool shape; null clears, absent keeps. */
function readAnchor(
  args: Record<string, unknown>,
): CommentAnchor | null | undefined {
  if (!('anchor' in args)) return undefined;
  const value = args.anchor;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    invalid('anchor 必须是 { block_id, offset, length } 对象，或用 null 清除锚点');
  const record = value as Record<string, unknown>;
  const blockId = record.block_id;
  if (typeof blockId !== 'string' || blockId.trim() === '')
    invalid(
      'anchor.block_id 必须是非空字符串（目标块 id，来自 space_doc_read 或 space_doc_outline）',
    );
  const offset = record.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)
    invalid('anchor.offset 必须是非负整数');
  const length = record.length;
  if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0)
    invalid('anchor.length 必须是正整数');
  return { blockId: blockId.trim(), offset, length };
}

/** Read one optional `quote`; null clears it, an empty string is rejected. */
function readQuote(
  args: Record<string, unknown>,
): string | null | undefined {
  if (!('quote' in args)) return undefined;
  const value = args.quote;
  if (value === null) return null;
  if (typeof value !== 'string') invalid('quote 必须是字符串或 null');
  const trimmed = value.trim();
  if (trimmed === '')
    invalid('quote 不能为空字符串；全文评论请省略 quote 或传 null');
  return trimmed;
}

/** Project one comment into the bounded tool view. */
function commentView(comment: Comment): CommentView {
  return {
    id: comment.id,
    doc_id: comment.docId,
    author: comment.author,
    body: clip(comment.body, PREVIEW_MAX),
    quote: comment.quote === null ? null : clip(comment.quote, PREVIEW_MAX),
    anchor:
      comment.anchor === null
        ? null
        : {
            block_id: comment.anchor.blockId,
            offset: comment.anchor.offset,
            length: comment.anchor.length,
          },
    status: comment.status,
    supplements_count: comment.supplements.length,
    created_at: comment.createdAt,
    resolved_at: comment.resolvedAt,
    deleted_at: comment.deletedAt,
    edited_at: comment.editedAt,
  };
}

/** Whether one action only reads; read actions are concurrency safe. */
function isReadAction(args: unknown): boolean {
  return (
    typeof args === 'object' &&
    args !== null &&
    (args as Record<string, unknown>).action === 'list'
  );
}

function renderCommentLine(comment: CommentView): string {
  const anchor =
    comment.anchor === null
      ? ''
      : ` @${comment.anchor.block_id}+${comment.anchor.offset}/${comment.anchor.length}`;
  const quote = comment.quote === null ? '' : ` 「${comment.quote}」`;
  const supplements =
    comment.supplements_count === 0
      ? ''
      : `（补充 ${comment.supplements_count} 条）`;
  return `- ${comment.id} [${comment.status}] ${comment.author}${quote}${anchor}：${comment.body}${supplements}`;
}

function renderComments(args: unknown, value: unknown): ToolTextBlock[] {
  const input = args as { action?: CommentAction } | null;
  const action = input?.action;
  const result = value as Record<string, unknown>;

  if (Array.isArray(result.comments)) {
    const comments = result.comments as CommentView[];
    const header = `文档 ${String(result.doc_id)}：共 ${String(result.total)} 条评论${
      result.truncated === true
        ? `，仅返回前 ${comments.length} 条（truncated）`
        : ''
    }`;
    return [
      text(
        comments.length === 0
          ? `${header}（无）`
          : [header, ...comments.map(renderCommentLine)].join('\n'),
      ),
    ];
  }
  if (result.deleted === true)
    return [
      text(
        `已删除评论 ${String(result.comment_id)}（软删除墓碑，不可恢复；历史评论仍可读取）。`,
      ),
    ];
  const comment = result.comment as CommentView | undefined;
  if (comment === undefined) return [text(JSON.stringify(value))];
  const headline =
    action === 'supplement'
      ? `已为评论 ${comment.id} 添加补充，共 ${comment.supplements_count} 条（status=${comment.status}）。`
      : action === 'resolve'
        ? `已采纳评论 ${comment.id}（status=${comment.status}）。`
        : action === 'add'
          ? `已添加评论 ${comment.id}（author=${comment.author}，status=${comment.status}）。`
          : `已更新评论 ${comment.id}（status=${comment.status}）。`;
  return [text(headline)];
}

/** Read every comment of one document as a bounded projection. */
async function listComments(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const docId = requireString(input, 'doc_id');
  const comments = (await deps.rpc('space.listComments', [
    docId,
  ])) as Comment[];
  return {
    doc_id: docId,
    total: comments.length,
    truncated: comments.length > LIST_LIMIT,
    comments: comments.slice(0, LIST_LIMIT).map(commentView),
  };
}

/** Create one comment (optionally anchored to a text range) as Alter. */
async function addComment(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const docId = requireString(input, 'doc_id');
  const body = requireString(input, 'body');
  const quote = readQuote(input);
  const anchor = readAnchor(input);
  const comment = (await deps.rpc('space.addComment', [
    {
      docId,
      body,
      ...(quote === undefined ? {} : { quote }),
      ...(anchor === undefined ? {} : { anchor }),
    },
  ])) as Comment;
  return { comment: commentView(comment) };
}

/** Update the body, quote or anchor of one comment; at least one field. */
async function updateComment(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const commentId = requireString(input, 'comment_id');
  const patch: {
    body?: string;
    quote?: string | null;
    anchor?: CommentAnchor | null;
  } = {};
  if ('body' in input) patch.body = requireString(input, 'body');
  const quote = readQuote(input);
  if (quote !== undefined) patch.quote = quote;
  const anchor = readAnchor(input);
  if (anchor !== undefined) patch.anchor = anchor;
  if (Object.keys(patch).length === 0)
    invalid('action=update 至少需要 body、quote 或 anchor 之一');
  const comment = (await deps.rpc('space.updateComment', [
    commentId,
    patch,
  ])) as Comment;
  return { comment: commentView(comment) };
}

/** Append one supplement (reply) to an existing comment thread. */
async function supplementComment(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const commentId = requireString(input, 'comment_id');
  const body = requireString(input, 'body');
  const comment = (await deps.rpc('space.addCommentSupplement', [
    commentId,
    body,
  ])) as Comment;
  return { comment: commentView(comment) };
}

/** Soft-delete one comment into a tombstone; irreversible, needs approval. */
async function deleteComment(
  deps: RpcToolDeps,
  exec: ToolRunContextLike,
  input: Record<string, unknown>,
): Promise<unknown> {
  const commentId = requireString(input, 'comment_id');
  await approveDestructive(
    deps,
    exec,
    '删除评论不可恢复：评论会变成删除墓碑（内容保留在历史评论中，但无法再打开或恢复），且不再出现在文档评论轨；确认删除该评论？',
  );
  await deps.rpc('space.deleteComment', [commentId]);
  return { deleted: true, comment_id: commentId, status: 'deleted' };
}

/** Mark one comment as resolved (accepted). */
async function resolveComment(
  deps: RpcToolDeps,
  input: Record<string, unknown>,
): Promise<unknown> {
  const commentId = requireString(input, 'comment_id');
  const comment = (await deps.rpc('space.resolveComment', [
    commentId,
  ])) as Comment;
  return { comment: commentView(comment) };
}

/** Dispatch one `space_comments` call to the matching endpoint. */
async function dispatch(
  deps: RpcToolDeps,
  exec: ToolRunContextLike,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = requireAction(input, COMMENT_ACTIONS);
  switch (action) {
    case 'list':
      return listComments(deps, input);
    case 'add':
      return addComment(deps, input);
    case 'update':
      return updateComment(deps, input);
    case 'supplement':
      return supplementComment(deps, input);
    case 'delete':
      return deleteComment(deps, exec, input);
    case 'resolve':
      return resolveComment(deps, input);
  }
}

/**
 * Register the Space comment tool on one Host tools service.
 * @param tools - Host tools service the definition is installed on.
 * @param deps - alter-bound RPC seam plus the lazy approval resolver.
 * @returns disposer that removes every registration.
 */
export function registerCommentTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: 'space_comments',
      description:
        "List, add, update, supplement, resolve or soft-delete comments on one Space document. Comments are attributed to Alter; delete is an irreversible tombstone that needs user approval. Read the document's comments first so you use real comment ids.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...COMMENT_ACTIONS],
            description: 'Comment operation to apply.',
          },
          doc_id: {
            type: 'string',
            description: 'Document id; required for list and add.',
          },
          comment_id: {
            type: 'string',
            description:
              'Comment id; required for update/supplement/delete/resolve.',
          },
          body: {
            type: 'string',
            description:
              'Comment text; required for add/supplement, optional for update.',
          },
          quote: {
            type: 'string',
            description:
              'Quoted text the comment refers to; omit or null for a whole-document comment.',
          },
          anchor: {
            type: 'object',
            additionalProperties: false,
            required: ['block_id', 'offset', 'length'],
            description:
              'Selection inside one block (block_id is the target block id).',
            properties: {
              block_id: {
                type: 'string',
                description: 'Target block id from space_doc_read/outline.',
              },
              offset: {
                type: 'integer',
                description: 'Non-negative plain-text offset in the block.',
              },
              length: {
                type: 'integer',
                description: 'Positive selected length.',
              },
            },
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (args, value) => renderComments(args, value),
      },
      isConcurrencySafe: (args) => isReadAction(args),
      async execute(args, exec) {
        try {
          const input = asRecord(args);
          return await dispatch(deps, exec, input);
        } catch (error) {
          throw toToolError(error, COMMENT_HINTS);
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Manage document comments',
        kind: 'edit',
      }),
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}