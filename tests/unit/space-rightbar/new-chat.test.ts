/**
 * The right-sidebar 「新建对话」 orchestration: reference resolution (page target
 * → space fallback), the create/open flow with inline failure copy, the
 * duplicate-click guard and the structural bridge reader.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NEW_CHAT_FAILED,
  NEW_CHAT_NO_TARGET,
  NEW_CHAT_OPEN_FAILED,
  createNewChatRunner,
  currentTabTarget,
  guideTargetOf,
  newChatBridge,
  resolveAutoRef,
  runNewChat,
  type NewChatDeps,
} from '../../../src/space-rightbar/new-chat';

/** A promise whose settlement the test controls (duplicate-click cases). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Deps with a page target and a working creation; override per test. */
function chatDeps(overrides: Partial<NewChatDeps> = {}): NewChatDeps {
  return {
    params: { spaceId: 'sp_1', nodeId: 'nd_2' },
    startPageChat: () => Promise.resolve({ sessionId: 'se_1' }),
    ...overrides,
  };
}

describe('currentTabTarget', () => {
  it('maps a document route to a page target', () => {
    expect(currentTabTarget('#/space/sp_1/doc/nd_2')).toEqual({
      spaceId: 'sp_1',
      nodeId: 'nd_2',
    });
  });

  it('maps every other space view to a space target', () => {
    expect(currentTabTarget('#/space/sp_1')).toEqual({ spaceId: 'sp_1' });
    expect(currentTabTarget('#/space/sp_1/overview')).toEqual({
      spaceId: 'sp_1',
    });
    expect(currentTabTarget('#/space/sp_1/thoughts/th_1')).toEqual({
      spaceId: 'sp_1',
    });
    // A document route without an id has no page to reference.
    expect(currentTabTarget('#/space/sp_1/doc')).toEqual({ spaceId: 'sp_1' });
  });

  it('resolves to no target outside a space route', () => {
    expect(currentTabTarget('#/space')).toEqual({});
    expect(currentTabTarget('#/elsewhere')).toEqual({});
  });
});

describe('guideTargetOf', () => {
  it('references the page the Space panel is showing', () => {
    expect(guideTargetOf('#/space/sp_1/doc/nd_2', true)).toEqual({
      spaceId: 'sp_1',
      nodeId: 'nd_2',
    });
  });

  it('references the space itself on a non-document view', () => {
    expect(guideTargetOf('#/space/sp_1/overview', true)).toEqual({ spaceId: 'sp_1' });
    expect(guideTargetOf('#/space/sp_1', true)).toEqual({ spaceId: 'sp_1' });
  });

  it('references nothing while the Space panel is not the centre', () => {
    // The right column beside a conversation has no space page on its left.
    expect(guideTargetOf('#/space/sp_1/doc/nd_2', false)).toEqual({});
  });
});

describe('resolveAutoRef', () => {
  it('references the page by its current title', async () => {
    const getNode = vi.fn(() => Promise.resolve({ title: '设计稿' }));
    const getSpaceName = vi.fn(() => Promise.resolve('产品空间'));

    await expect(
      resolveAutoRef(
        { spaceId: 'sp_1', nodeId: 'nd_2' },
        { getNode, getSpaceName },
      ),
    ).resolves.toEqual({
      spaceId: 'sp_1',
      nodeId: 'nd_2',
      nodeTitle: '设计稿',
    });
    expect(getNode).toHaveBeenCalledWith('nd_2');
    // The page title wins: the space name is never read for a page target.
    expect(getSpaceName).not.toHaveBeenCalled();
  });

  it('falls back to the space when the tab has no page', async () => {
    const getNode = vi.fn(() => Promise.resolve({ title: '设计稿' }));
    const getSpaceName = vi.fn(() => Promise.resolve('产品空间'));

    await expect(
      resolveAutoRef({ spaceId: 'sp_1' }, { getNode, getSpaceName }),
    ).resolves.toEqual({
      spaceId: 'sp_1',
      nodeId: null,
      nodeTitle: '产品空间',
    });
    expect(getNode).not.toHaveBeenCalled();
    expect(getSpaceName).toHaveBeenCalledWith('sp_1');
  });

  it('falls back to the space when the page is gone', async () => {
    await expect(
      resolveAutoRef(
        { spaceId: 'sp_1', nodeId: 'nd_2' },
        {
          getNode: () => Promise.resolve(undefined),
          getSpaceName: () => Promise.resolve('产品空间'),
        },
      ),
    ).resolves.toEqual({
      spaceId: 'sp_1',
      nodeId: null,
      nodeTitle: '产品空间',
    });
  });

  it('falls back to the space when the title lookups fail or are blank', async () => {
    await expect(
      resolveAutoRef(
        { spaceId: 'sp_1', nodeId: 'nd_2' },
        {
          getNode: () => Promise.reject(new Error('rpc down')),
          getSpaceName: () => Promise.resolve('产品空间'),
        },
      ),
    ).resolves.toEqual({
      spaceId: 'sp_1',
      nodeId: null,
      nodeTitle: '产品空间',
    });

    await expect(
      resolveAutoRef(
        { spaceId: 'sp_1', nodeId: 'nd_2' },
        { getNode: () => Promise.resolve({ title: '   ' }) },
      ),
    ).resolves.toEqual({ spaceId: 'sp_1', nodeId: null, nodeTitle: 'sp_1' });
  });

  it('uses the space id when the space name is unavailable', async () => {
    await expect(
      resolveAutoRef(
        { spaceId: 'sp_1' },
        { getSpaceName: () => Promise.reject(new Error('no')) },
      ),
    ).resolves.toEqual({ spaceId: 'sp_1', nodeId: null, nodeTitle: 'sp_1' });
  });

  it('resolves to null without a space target', async () => {
    const getNode = vi.fn(() => Promise.resolve({ title: '设计稿' }));
    await expect(
      resolveAutoRef({ nodeId: 'nd_2' }, { getNode }),
    ).resolves.toBeNull();
    expect(getNode).not.toHaveBeenCalled();
    await expect(resolveAutoRef(undefined, { getNode })).resolves.toBeNull();
  });
});

describe('runNewChat', () => {
  it('creates the page conversation and opens it beside the tab', async () => {
    const startPageChat = vi.fn(() => Promise.resolve({ sessionId: 'se_1' }));
    const openAside = vi.fn();
    const onError = vi.fn();

    await expect(
      runNewChat(
        chatDeps({
          startPageChat,
          openAside,
          getNode: () => Promise.resolve({ title: '设计稿' }),
          onError,
        }),
      ),
    ).resolves.toBe('ok');

    expect(startPageChat).toHaveBeenCalledWith({
      spaceId: 'sp_1',
      nodeId: 'nd_2',
      nodeTitle: '设计稿',
    });
    expect(openAside).toHaveBeenCalledWith('se_1');
    expect(onError).not.toHaveBeenCalled();
  });

  it('creates a space-only conversation for a space target', async () => {
    const startPageChat = vi.fn(() => Promise.resolve({ sessionId: 'se_1' }));
    const openAside = vi.fn();

    await expect(
      runNewChat(
        chatDeps({
          params: { spaceId: 'sp_1' },
          startPageChat,
          openAside,
          getSpaceName: () => Promise.resolve('产品空间'),
        }),
      ),
    ).resolves.toBe('ok');

    expect(startPageChat).toHaveBeenCalledWith({
      spaceId: 'sp_1',
      nodeId: null,
      nodeTitle: '产品空间',
    });
    expect(openAside).toHaveBeenCalledWith('se_1');
  });

  it('falls back to the main-view opener when the sidebar one is missing', async () => {
    const openMain = vi.fn();
    await expect(runNewChat(chatDeps({ openMain }))).resolves.toBe('ok');
    expect(openMain).toHaveBeenCalledWith('se_1');
  });

  it('succeeds without any opener (the bridge already opened the session)', async () => {
    await expect(runNewChat(chatDeps())).resolves.toBe('ok');
  });

  it('reports a failed creation inline with the required copy', async () => {
    const openAside = vi.fn();
    const onError = vi.fn();

    await expect(
      runNewChat(
        chatDeps({
          startPageChat: () => Promise.reject(new Error('session limit')),
          openAside,
          onError,
        }),
      ),
    ).resolves.toBe('failed');

    expect(onError).toHaveBeenCalledWith(`${NEW_CHAT_FAILED}（session limit）`);
    expect(openAside).not.toHaveBeenCalled();
  });

  it('keeps an already-prefixed failure message as it is', async () => {
    const onError = vi.fn();
    const message = `${NEW_CHAT_FAILED}（工作区不可用）`;

    await expect(
      runNewChat(
        chatDeps({
          startPageChat: () => Promise.reject(new Error(message)),
          onError,
        }),
      ),
    ).resolves.toBe('failed');

    expect(onError).toHaveBeenCalledWith(message);
  });

  it('reports a rejection without a message with the generic copy', async () => {
    const onError = vi.fn();
    await expect(
      runNewChat(
        chatDeps({ startPageChat: () => Promise.reject('boom'), onError }),
      ),
    ).resolves.toBe('failed');
    expect(onError).toHaveBeenCalledWith(NEW_CHAT_FAILED);
  });

  it('fails when the created conversation has no session', async () => {
    const openAside = vi.fn();
    const onError = vi.fn();

    await expect(
      runNewChat(
        chatDeps({
          startPageChat: () => Promise.resolve({ sessionId: null }),
          openAside,
          onError,
        }),
      ),
    ).resolves.toBe('failed');

    expect(onError).toHaveBeenCalledWith(NEW_CHAT_FAILED);
    expect(openAside).not.toHaveBeenCalled();
  });

  it('fails without creating anything when there is no target', async () => {
    const startPageChat = vi.fn(() => Promise.resolve({ sessionId: 'se_1' }));
    const onError = vi.fn();

    await expect(
      runNewChat(chatDeps({ params: {}, startPageChat, onError })),
    ).resolves.toBe('failed');

    expect(startPageChat).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(NEW_CHAT_NO_TARGET);
  });

  it('keeps the created conversation when opening it fails', async () => {
    const onError = vi.fn();

    await expect(
      runNewChat(
        chatDeps({
          openAside: () => {
            throw new Error('no sidebar');
          },
          onError,
        }),
      ),
    ).resolves.toBe('ok');

    expect(onError).toHaveBeenCalledWith(NEW_CHAT_OPEN_FAILED);
  });
});

describe('createNewChatRunner', () => {
  it('creates exactly one conversation for concurrent clicks', async () => {
    const creation = deferred<{ sessionId: string | null }>();
    const startPageChat = vi.fn(() => creation.promise);
    const runner = createNewChatRunner();

    expect(runner.pending).toBe(false);

    const first = runner.run(chatDeps({ startPageChat }));
    const second = runner.run(chatDeps({ startPageChat }));
    // Reference resolution is async: let the first run reach the creation call.
    await vi.waitFor(() => expect(startPageChat).toHaveBeenCalledTimes(1));
    expect(runner.pending).toBe(true);

    creation.resolve({ sessionId: 'se_1' });

    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(runner.pending).toBe(false);
    expect(startPageChat).toHaveBeenCalledTimes(1);
  });

  it('accepts a new click after the previous run settled', async () => {
    const startPageChat = vi.fn(() => Promise.resolve({ sessionId: 'se_1' }));
    const runner = createNewChatRunner();

    await expect(runner.run(chatDeps({ startPageChat }))).resolves.toBe('ok');
    await expect(runner.run(chatDeps({ startPageChat }))).resolves.toBe('ok');

    expect(startPageChat).toHaveBeenCalledTimes(2);
  });
});

describe('newChatBridge', () => {
  it('reads nothing from an absent or partial bridge', () => {
    expect(newChatBridge(null)).toBeNull();
    expect(newChatBridge(undefined)).toBeNull();
    expect(newChatBridge('bridge')).toBeNull();
    expect(newChatBridge({ toggleRightbar: () => undefined })).toBeNull();
  });

  it('forwards creation and the optional aside opener', async () => {
    const calls: unknown[] = [];
    const source = {
      calls,
      startPageChat(input: unknown) {
        calls.push({ self: this, input });
        return Promise.resolve({ sessionId: 'se_1' });
      },
      openSessionAside(sessionId: string) {
        calls.push({ self: this, sessionId });
      },
    };

    const bridge = newChatBridge(source);
    expect(bridge).not.toBeNull();

    const ref = { spaceId: 'sp_1', nodeId: null, nodeTitle: '产品空间' };
    await expect(bridge!.startPageChat(ref)).resolves.toEqual({
      sessionId: 'se_1',
    });
    bridge!.openSessionAside?.('se_1');

    expect(calls).toHaveLength(2);
    // `this` stays the installed bridge: the real bridge is an object literal.
    // The entry asks for the sidebar host, so the main view is untouched.
    expect(calls[0]).toEqual({
      self: source,
      input: { ...ref, open: 'aside' },
    });
    expect(calls[1]).toEqual({ self: source, sessionId: 'se_1' });
  });

  it('leaves the aside opener absent when the bridge lacks it', () => {
    const bridge = newChatBridge({
      startPageChat: () => Promise.resolve({ sessionId: 'se_1' }),
    });
    expect(bridge).not.toBeNull();
    expect(bridge!.openSessionAside).toBeUndefined();
  });
});
