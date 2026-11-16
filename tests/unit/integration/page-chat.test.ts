/**
 * Page-conversation creation: it must never call `ctx.sessions.create`.
 *
 * `ISessions` (the `ctx.sessions` contract) deliberately exposes no `create`;
 * session creation belongs to the workspace flow. An earlier build called it
 * anyway, so 「AI 对话」 threw `ctx.sessions.create is not a function` at
 * runtime. These cases pin the sanctioned path and the space-level fallback.
 */
import { describe, expect, it, vi } from 'vitest';
import { PageChatError, createPageChat } from '../../../src/integration/page-chat';
import type { ChatStore } from '../../../src/chat/store';

/** Store double recording the chat it was asked to create. */
function storeDouble(overrides: Partial<ChatStore['actions']> = {}) {
  const created: unknown[] = [];
  const store = {
    chats: { getSnapshot: () => [], subscribe: () => () => {} },
    sideChats: { getSnapshot: () => [], subscribe: () => () => {} },
    pageChats: { getSnapshot: () => [], subscribe: () => () => {} },
    chatOfSession: () => undefined,
    chatSourceOfSession: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    actions: {
      refresh: vi.fn(),
      createPageChat: vi.fn(async (input: unknown) => {
        created.push(input);
        return { id: 'ch_1' } as never;
      }),
      createSideChat: vi.fn(),
      setRefs: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      patch: vi.fn(),
      ...overrides,
    },
  };
  return { store: store as unknown as ChatStore, created };
}

/** Client context double with the two faces creation touches. */
function contextOf(options: {
  workspaceId?: string | null;
  connect?: (workspaceId: string) => Promise<string>;
  start?: (workspaceId?: string) => void;
  create?: () => Promise<string>;
  ids?: string[];
}) {
  const rpc = {
    call: vi.fn(async () => ({
      ok: true,
      value: options.workspaceId === undefined || options.workspaceId === null
        ? null
        : { workspaceId: options.workspaceId },
    })),
  };
  return {
    rpc,
    context: {
      connection: { rpc },
      sessions: {
        ...(options.create === undefined ? {} : { create: options.create }),
        list: {
          getSnapshot: () => ({
            ids: options.ids ?? [],
            byId: Object.fromEntries(
              (options.ids ?? []).map((id) => [id, { blank: true }]),
            ),
          }),
        },
        fork: vi.fn(),
        archiveSession: vi.fn(),
      },
      uiWorkspace: {
        openSession: vi.fn(),
        openWorkspace: vi.fn(),
        ...(options.connect === undefined
          ? {}
          : { connectWorkspace: options.connect }),
        ...(options.start === undefined ? {} : { startSession: options.start }),
      },
    },
  };
}

describe('createPageChat', () => {
  it('creates the Session through the workspace flow, never through ctx.sessions', async () => {
    const connect = vi.fn(async () => 'se_1');
    const { context, rpc } = contextOf({ workspaceId: 'ws_1', connect });
    const { store, created } = storeDouble();

    const result = await createPageChat(context as never, store, {
      spaceId: 'sp_1',
      nodeId: 'doc_1',
      title: '页面 A',
    });

    expect(result.sessionId).toBe('se_1');
    expect(rpc.call).toHaveBeenCalledWith('/api', 'alter-space', {
      op: 'space.getWorkspaceLink',
      args: ['sp_1'],
    });
    expect(connect).toHaveBeenCalledWith('ws_1');
    expect(created).toEqual([
      {
        spaceId: 'sp_1',
        nodeId: 'doc_1',
        sessionId: 'se_1',
        title: '页面 A',
      },
    ]);
    // The contract has no `create`; a re-introduction must fail this case.
    expect('create' in (context.sessions as Record<string, unknown>)).toBe(false);
  });

  it('records a space-level conversation when no page is given', async () => {
    const connect = vi.fn(async () => 'se_2');
    const { context } = contextOf({ workspaceId: 'ws_1', connect });
    const { store, created } = storeDouble();
    await createPageChat(context as never, store, {
      spaceId: 'sp_1',
      nodeId: null,
    });
    expect(created).toEqual([
      { spaceId: 'sp_1', nodeId: null, sessionId: 'se_2' },
    ]);
  });

  it('creates the Session directly when the space has no workspace', async () => {
    // The workspace flow is only one way in: a space without a mapped
    // workspace still gets a Session, and creation must not navigate — the
    // conversation belongs in the right column, not in the centre.
    const create = vi.fn(async () => 'se_fallback');
    const start = vi.fn();
    const { context } = contextOf({ workspaceId: null, create, start });
    const { store } = storeDouble();
    const result = await createPageChat(context as never, store, {
      spaceId: 'sp_1',
      nodeId: null,
    });
    expect(create).toHaveBeenCalledTimes(1);
    // `startSession` shows the Conversation; it must never be the fallback.
    expect(start).not.toHaveBeenCalled();
    expect(result.sessionId).toBe('se_fallback');
  });

  it('puts the centre panel back when the workspace flow navigated away', async () => {
    // `connectWorkspace` is a navigation: it may show the Session it resolved.
    // A conversation destined for the right column must leave the Space panel
    // where the reader left it.
    let activePanelId: string | null = 'alter-space';
    const selectPanel = vi.fn((id: string | null) => {
      activePanelId = id;
    });
    const connect = vi.fn(async () => {
      activePanelId = null; // the flow showed the conversation
      return 'se_nav';
    });
    const { context } = contextOf({ workspaceId: 'ws_1', connect });
    (context as Record<string, unknown>).layout = {
      panelInfo: { getSnapshot: () => ({ activePanelId }) },
      selectPanel,
    };
    const { store } = storeDouble();
    await createPageChat(context as never, store, {
      spaceId: 'sp_1',
      nodeId: 'doc_1',
    });
    expect(selectPanel).toHaveBeenCalledWith('alter-space');
    expect(activePanelId).toBe('alter-space');
  });

  it('never prompts for a workspace: it uses the space directory instead', async () => {
    const create = vi.fn(async () => 'se_dir');
    const { context, rpc } = contextOf({ workspaceId: null, create });
    (rpc.call as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_channel: string, _endpoint: string, payload: { op: string }) => {
        if (payload.op === 'space.getSpace') {
          return { ok: true, value: { value: { directories: ['/tmp/space'] } } };
        }
        return { ok: true, value: { value: null } };
      },
    );
    const { store } = storeDouble();
    await createPageChat(context as never, store, {
      spaceId: 'sp_1',
      nodeId: null,
    });
    expect(create).toHaveBeenCalledWith({ cwd: '/tmp/space' });
  });

  it('reports inline copy when the workspace flow refuses', async () => {
    const connect = vi.fn(async () => {
      throw new Error('工作区不可用');
    });
    const { context } = contextOf({ workspaceId: 'ws_1', connect });
    const { store } = storeDouble();
    await expect(
      createPageChat(context as never, store, { spaceId: 'sp_1', nodeId: null }),
    ).rejects.toBeInstanceOf(PageChatError);
    await expect(
      createPageChat(context as never, store, { spaceId: 'sp_1', nodeId: null }),
    ).rejects.toThrow(/对话创建失败，请重试（工作区不可用）/);
  });
});
