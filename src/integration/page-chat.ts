/**
 * Page-chat session creation (页面菜单「AI 对话」/ 右侧栏「新建对话」).
 *
 * A page conversation is an ordinary DSH session in the space's mapped
 * workspace, so the Agent gets the space's directory as its working context;
 * the chat record + reference are registered with the Host side tables. The
 * caller decides where the conversation opens (right sidebar tab or main
 * view); this module only creates and records it.
 *
 * Session creation goes through the workspace flow: `ISessions` exposes no
 * `create` (that would bypass workspace ownership), while
 * `uiWorkspace.connectWorkspace(workspaceId)` reuses a reusable blank member or
 * creates one, and it does not navigate — the caller decides where to show it.
 */
import type { Chat } from '@alter/protocol';
import type { ChatStore } from '../chat/store';
import { holdCenterPanel } from './center-panel';
import { workspaceOfSpace, type SpaceClientContext } from './dsh';

/** Failure carrying a user-facing message for inline display (no toast). */
export class PageChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageChatError';
  }
}

/** Inline copy for a failed creation (the caller may append the reason). */
const CREATE_FAILED = '对话创建失败，请重试';

/**
 * Create and record one page conversation.
 * @param ctx - client context carrying the workspace and sidebar faces.
 * @param store - chat store the record is written to.
 * @param input - the space, the page (null for a space-level conversation), and its name.
 * @returns the new session id and the recorded chat.
 * @throws {PageChatError} with inline-ready copy when no session could be created.
 */
export async function createPageChat(
  ctx: SpaceClientContext,
  store: ChatStore,
  input: { spaceId: string; nodeId: string | null; title?: string },
): Promise<{ sessionId: string; chat: Chat }> {
  // A space-level conversation (no page) still registers one reference: the
  // space itself, which is what the Agent then reads.
  let workspaceId: string | null = null;
  try {
    workspaceId = await workspaceOfSpace(ctx, input.spaceId);
  } catch {
    // Workspace binding is optional: the Session still works, the Agent just
    // has no mapped directory.
  }
  // The workspace flow is allowed to navigate; a conversation destined for the
  // right column must not swap the Space panel out of the centre.
  const center = holdCenterPanel(ctx);
  // A workspace the space maps is the normal host for the session; without one
  // the space's main directory still gives the controller enough to place it
  // (`cwd`), which avoids asking the reader to pick a workspace mid-flow.
  const directory =
    workspaceId === null ? await directoryOfSpace(ctx, input.spaceId) : null;
  const sessionId = await createSession(ctx, workspaceId, directory).finally(() => {
    center.restore();
  });
  const chat = await store.actions.createPageChat({
    spaceId: input.spaceId,
    nodeId: input.nodeId,
    sessionId,
    // The page (or space) name is what a history row shows before the Host
    // generates a session title.
    ...(input.title === undefined ? {} : { title: input.title }),
  });
  return { sessionId, chat };
}

/**
 * Resolve the Session for a new page conversation.
 *
 * With a mapped workspace the workspace flow reuses a reusable blank member
 * (so repeated entries do not litter the session list) or creates one; without
 * one it falls back to opening a blank Session through the same flow, whose id
 * the caller reads back from the selection.
 * @param ctx - client context.
 * @param workspaceId - the space's mapped DSH workspace, when it has one.
 * @returns the Session id to record.
 * @throws {PageChatError} when no Session could be resolved.
 */
async function createSession(
  ctx: SpaceClientContext,
  workspaceId: string | null,
  directory: string | null = null,
): Promise<string> {
  const connect = ctx.uiWorkspace.connectWorkspace;
  if (workspaceId !== null && typeof connect === 'function') {
    try {
      return await connect.call(ctx.uiWorkspace, workspaceId);
    } catch (error) {
      throw new PageChatError(withReason(error));
    }
  }
  // No mapped workspace (or a host without the workspace flow): create the
  // Session directly. `uiWorkspace.startSession` would *show* the Conversation
  // and `openSession` would too, so a conversation that belongs in the right
  // column must never go through either of them.
  const create = ctx.sessions.create;
  if (typeof create !== 'function') throw new PageChatError(CREATE_FAILED);
  try {
    // Prefer the mapped workspace; otherwise hand the controller the space's
    // directory so it resolves one instead of prompting.
    const target =
      workspaceId !== null
        ? { workspaceId }
        : directory !== null
          ? { cwd: directory }
          : {};
    return await create.call(ctx.sessions, target);
  } catch (error) {
    throw new PageChatError(withReason(error));
  }
}

/** First working directory of a space, when it has one. */
async function directoryOfSpace(
  ctx: SpaceClientContext,
  spaceId: string,
): Promise<string | null> {
  try {
    const result = await ctx.connection.rpc.call('/api', 'alter-space', {
      op: 'space.getSpace',
      args: [spaceId],
    });
    if (!result.ok) return null;
    const body = result.value as { value?: { directories?: unknown } } | null;
    const directories = body?.value?.directories;
    if (!Array.isArray(directories)) return null;
    const first = directories[0];
    return typeof first === 'string' && first !== '' ? first : null;
  } catch {
    return null;
  }
}

/** Inline copy with the underlying reason appended, when there is one. */
function withReason(error: unknown): string {
  const reason = error instanceof Error ? error.message.trim() : '';
  return reason === '' ? CREATE_FAILED : `${CREATE_FAILED}（${reason}）`;
}


