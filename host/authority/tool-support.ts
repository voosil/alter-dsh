/**
 * Shared plumbing for the model-facing Space tools.
 *
 * Every Agent tool validates its own arguments (DSH only checks JSON syntax) and
 * reports failures with a stable code plus the next actionable step. Those
 * helpers, the approval bridge and the generic authority RPC seam live here so
 * the tool domains added after P1 do not fork their own error vocabulary.
 *
 * The RPC seam keeps the authority in charge: tools name an endpoint and the
 * Host routes it to the alter identity stack (only a few curated calls are
 * unwrapped to plain values). Domain tools therefore never re-implement
 * persistence, migration or offline semantics.
 *
 * @module @alter-dsh/space/authority/tool-support
 */
import type {
  ToolRunContextLike,
  ToolTextBlock,
} from '../document/editors/legacy/tools.js';

/** One authority endpoint call bound to the alter identity stack. */
export type RpcCall = (
  endpoint: string,
  args: unknown[],
) => Promise<unknown>;

/** DSH approval subset the destructive Space tools need. */
export interface ApprovalLike {
  request(request: {
    agent: unknown;
    toolName: string;
    callId?: unknown;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

/** Dependencies shared by every authority-backed domain tool. */
export interface RpcToolDeps {
  /** Alter-bound endpoint call (local alter stack or the bridge's stamped port). */
  rpc: RpcCall;
  /** Lazily resolves the approval service; destructive actions fail closed. */
  approval?: () => ApprovalLike | undefined;
}

/** A tool-layer rejection carrying a stable code in the message prefix. */
export class AgentToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentToolError';
    this.code = code;
  }
}

/** Reject one argument value; the message tells the model what to send instead. */
export function invalid(message: string): never {
  throw new AgentToolError('space/invalid-input', message);
}

/** Reject an id the authority does not know. */
export function notFound(message: string): never {
  throw new AgentToolError('space/not-found', message);
}

/** Treat one tool argument as a plain object. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('参数必须是对象');
  return value as Record<string, unknown>;
}

/** Read the `action` discriminator of one action-dispatched tool. */
export function requireAction<T extends string>(
  input: Record<string, unknown>,
  allowed: readonly T[],
): T {
  const value = input.action;
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  )
    invalid(`action 必须是 ${allowed.join(' | ')} 之一`);
  return value as T;
}

/** Required non-empty string argument. */
export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '')
    invalid(`${key} 必须是非空字符串`);
  return value.trim();
}

/** Optional trimmed string argument. */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${key} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Required boolean argument. */
export function requireBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') invalid(`${key} 必须是布尔值`);
  return value;
}

/** Optional boolean argument. */
export function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(`${key} 必须是布尔值`);
  return value;
}

/** Optional integer argument with optional inclusive bounds. */
export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value))
    invalid(`${key} 必须是整数`);
  if (bounds.min !== undefined && value < bounds.min)
    invalid(`${key} 至少为 ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max)
    invalid(`${key} 最多为 ${bounds.max}`);
  return value;
}

/** Required non-empty array of non-empty strings (ids, order lists). */
export function requireStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0)
    invalid(`${key} 必须是非空字符串数组`);
  const entries = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '')
      invalid(`${key} 的每一项都必须是非空字符串`);
    return entry.trim();
  });
  return entries;
}

/** Clip one preview string to a bounded length. */
export function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Stable code of a thrown value, when it carries one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** One vendor rejection that a re-read of the target can resolve. */
export interface ErrorHint {
  /** Substring of the vendor message this hint answers. */
  match: string;
  /** Next step appended to the tool error. */
  hint: string;
}

const MOVED_NODES: readonly ErrorHint[] = [
  {
    match: '不能移动到自身',
    hint: '请用 space_browse tree 重新定位节点与目标位置后重试。',
  },
  {
    match: '不能移动到自己的子层级',
    hint: '请用 space_browse tree 重新定位节点与目标位置后重试。',
  },
  {
    match: '文件夹只能位于根目录',
    hint: '文件夹只能位于根目录：parent_id 必须为 null。',
  },
  {
    match: '文件夹只能创建在根目录',
    hint: '文件夹只能创建在根目录：请省略 parent_id。',
  },
  {
    match: '目标位置不属于目标空间',
    hint: '请用 space_browse tree 重新定位节点与目标位置后重试。',
  },
  {
    match: '上级目录不属于当前空间',
    hint: '请用 space_browse tree 重新定位节点与目标位置后重试。',
  },
];

/**
 * Map any failure to a stable tool error with the next actionable step.
 *
 * Tool-layer errors already carry their hint; authority codes pass through;
 * generic vendor messages become `space/failed` (existence → `space/not-found`).
 */
export function toToolError(
  error: unknown,
  hints: readonly ErrorHint[] = MOVED_NODES,
): Error {
  if (error instanceof AgentToolError)
    return new Error(`${error.code}: ${error.message}`);
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'remote/unavailable')
    return new Error(
      `remote/unavailable: ${message}；服务端离线，本次操作未执行：请恢复连接后重试（可用 space_settings test 检查连接）。`,
    );
  if (code === 'migration/read-only')
    return new Error(
      `migration/read-only: ${message}；请等待迁移完成后重试。`,
    );
  if (code === undefined || code === 'space/failed') {
    if (message.includes('空间不存在') || message.includes('文档不存在'))
      return new Error(
        `space/not-found: ${message}；请先用 space_browse（spaces/tree/trash）定位目标后重试。`,
      );
    const hint = hints.find((entry) => message.includes(entry.match));
    if (hint !== undefined)
      return new Error(`space/failed: ${message}；${hint.hint}`);
    return new Error(`space/failed: ${message}`);
  }
  return new Error(`${code}: ${message}`);
}

/**
 * Ask the user before one irreversible Space action.
 *
 * Without an approval service the call fails closed: the tool never performs a
 * destructive write on its own judgement.
 */
export async function approveDestructive(
  deps: RpcToolDeps,
  exec: ToolRunContextLike,
  reason: string,
): Promise<void> {
  const approval = deps.approval?.();
  if (approval === undefined)
    throw new Error(
      '该操作不可恢复，需要用户确认；当前宿主没有审批服务，已取消',
    );
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  });
  if (outcome !== 'allowed-once')
    throw new Error(`用户未批准该操作（${outcome}），已取消`);
}

/** One text block for a tool result. */
export function text(value: string): ToolTextBlock {
  return { type: 'text', text: value };
}