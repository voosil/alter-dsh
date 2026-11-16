// @vitest-environment jsdom
/**
 * 侧边对话历史 view: the three run markers and the acknowledgement path.
 *
 * The row reads two injected facts — the Host session list (running) and the
 * unread tracker (a stop the user has not seen). This suite drives the real
 * registration with structural doubles, renders the registered component, and
 * checks that 「打开」 clears the marker before opening the tab.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@alter/protocol';
import {
  SIDE_HISTORY_VIEW_ID,
  registerSideHistoryView,
  type SideHistoryContext,
  type SideHistoryStoreSource,
} from '../../../src/space-conversation/side-history';
import { createSideUnreadTracker } from '../../../src/space-conversation/side-status';

afterEach(() => {
  cleanup();
});

const NOW = new Date().toISOString();

/** One recorded branch of the given session. */
function sideChat(id: string, sessionId: string, title: string): Chat {
  return {
    id,
    kind: 'side',
    sessionId,
    title,
    sideOf: { sessionId: 'main-1', title: '主对话' },
    refs: [],
    quote: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Chat store double over a fixed record list. */
function storeDouble(chats: readonly Chat[]): SideHistoryStoreSource {
  return {
    sideChats: {
      getSnapshot: () => chats,
      subscribe: () => () => undefined,
    },
    actions: {
      rename: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
    },
  };
}

/** Session list double publishing one running bit per session. */
function listDouble(running: Record<string, boolean>) {
  const byId = Object.fromEntries(
    Object.entries(running).map(([id, value]) => [id, { running: value }]),
  );
  return { getSnapshot: () => ({ byId }), subscribe: () => () => undefined };
}

/**
 * Register the view with doubles and render the component it registered, with
 * the props the entry injects.
 */
function renderHistory(options: {
  readonly chats: readonly Chat[];
  readonly running: Record<string, boolean>;
  readonly unread: ReadonlySet<string>;
  readonly openResource?: (address: string, options?: Record<string, unknown>) => void;
  readonly openMain?: (sessionId: string) => void;
}) {
  const registered: { options?: Record<string, unknown>; component?: unknown } = {};
  const acknowledge = vi.fn();
  const injected: Record<string, unknown> = {};
  const ctx = {
    slots: {
      inject: (_key: string, callback: () => () => void) => {
        callback();
      },
      register: (definition: Record<string, unknown>, component: unknown) => {
        registered.options = definition;
        registered.component = component;
        return () => undefined;
      },
    },
    sidebarRight: {
      openResource: options.openResource ?? (() => undefined),
    },
    sessions: { list: listDouble(options.running) },
    ...(options.openMain === undefined ? {} : { openMain: options.openMain }),
    unread: {
      getSnapshot: () => options.unread,
      subscribe: () => () => undefined,
      acknowledge,
    },
  } as unknown as SideHistoryContext;
  const dispose = registerSideHistoryView(ctx, storeDouble(options.chats));
  const component = registered.component as (props: Record<string, unknown>) => unknown;
  const inject = registered.options?.inject as (() => Record<string, unknown>) | undefined;
  Object.assign(injected, inject?.() ?? {});
  const openView = vi.fn();
  render(createElement(component as never, {
    openView,
    completeViewRequest: vi.fn(),
    viewRequest: null,
    ...injected,
  }));
  return {
    dispose,
    acknowledge,
    openView,
    openResource: injected.openSideChat as (id: string) => void,
  };
}

describe('SideChatHistory markers', () => {
  it('registers under the conversation view seat with this id', () => {
    const { dispose } = renderHistory({
      chats: [sideChat('c1', 's1', '分支一')],
      running: { s1: false },
      unread: new Set(),
    });
    expect(SIDE_HISTORY_VIEW_ID).toBe('space-side-history');
    expect(screen.getByText('分支一')).toBeDefined();
    dispose();
  });

  it('renders 生成中, 已完成 and 空闲 from the two injected facts', () => {
    const { dispose } = renderHistory({
      chats: [
        sideChat('c1', 's1', '正在生成'),
        sideChat('c2', 's2', '完成了'),
        sideChat('c3', 's3', '空闲着'),
      ],
      running: { s1: true, s2: false, s3: false },
      unread: new Set(['s2']),
    });
    expect(screen.getByText('生成中')).toBeDefined();
    expect(screen.getByText('已完成')).toBeDefined();
    expect(screen.getByText('空闲')).toBeDefined();
    dispose();
  });

  it('marks nothing for a branch the session list does not hold', () => {
    const { dispose } = renderHistory({
      chats: [sideChat('c1', 's-unknown', '未知会话')],
      running: {},
      unread: new Set(),
    });
    expect(screen.queryByText('生成中')).toBeNull();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.queryByText('空闲')).toBeNull();
    dispose();
  });

  it('acknowledges the branch before opening its tab', async () => {
    const openResource = vi.fn();
    const { dispose, openView } = renderHistory({
      chats: [sideChat('c1', 's1', '花絮')],
      running: { s1: false, 'main-1': false },
      unread: new Set(['s1']),
      openResource,
    });
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    await waitFor(() => expect(openResource).toHaveBeenCalledTimes(1));
    expect(openResource).toHaveBeenCalledWith(
      'dsh-resource://spacechat/session/s1',
      expect.objectContaining({ kind: 'alter-space.side' }),
    );
    expect(screen.getByText('已完成')).toBeDefined();
    // The main area returns to 对话, the way the history tab describes opening.
    expect(openView).toHaveBeenCalledWith('chat', '');
    dispose();
  });

  it('offers 在主对话中打开 and switches the main area to 对话', () => {
    const openMain = vi.fn();
    const { dispose, openView } = renderHistory({
      chats: [sideChat('c1', 's1', '花絮')],
      running: { s1: false, 'main-1': false },
      unread: new Set(),
      openMain,
    });
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '在主对话中打开' }));
    expect(openMain).toHaveBeenCalledWith('s1');
    expect(openView).toHaveBeenCalledWith('chat', '');
    dispose();
  });

  it('marks a branch whose source conversation is gone', () => {
    const { dispose } = renderHistory({
      // The list holds the branch but not the conversation it branched from.
      chats: [sideChat('c1', 's1', '花絮')],
      running: { s1: false },
      unread: new Set(),
    });
    expect(screen.getByText('来源已删除')).toBeDefined();
    expect(screen.queryByText('分支自《主对话》')).toBeNull();
    dispose();
  });

  it('narrows the list with the search box and says so when nothing matches', () => {
    const { dispose } = renderHistory({
      chats: [
        sideChat('c1', 's1', '三种协作模式'),
        sideChat('c2', 's2', '权限模型'),
      ],
      running: { s1: false, s2: false, 'main-1': false },
      unread: new Set(),
    });
    const search = screen.getByRole('searchbox', { name: '搜索侧边对话' });
    fireEvent.change(search, { target: { value: '权限' } });
    expect(screen.queryByText('三种协作模式')).toBeNull();
    expect(screen.getByText('权限模型')).toBeDefined();
    fireEvent.change(search, { target: { value: '不存在' } });
    expect(screen.getByText('没有匹配的侧边对话')).toBeDefined();
    dispose();
  });

  it('groups rows by source when the toggle is on', () => {
    const { dispose } = renderHistory({
      chats: [
        sideChat('c1', 's1', '甲'),
        sideChat('c2', 's2', '乙'),
      ],
      running: { s1: false, s2: false, 'main-1': false },
      unread: new Set(),
    });
    const toggle = screen.getByRole('button', { name: '按来源分组' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // Both records branch from the same source, so one heading carries two rows.
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('来源：主对话 2');
    dispose();
  });

  it('keeps the source title while the source conversation exists', () => {
    const { dispose } = renderHistory({
      chats: [sideChat('c1', 's1', '花絮')],
      running: { s1: false, 'main-1': false },
      unread: new Set(),
    });
    expect(screen.getByText('分支自《主对话》')).toBeDefined();
    expect(screen.queryByText('来源已删除')).toBeNull();
    dispose();
  });
});

describe('createSideUnreadTracker with the history view', () => {
  it('drops the marker when the tracker acknowledges the session', async () => {
    const listeners = new Set<() => void>();
    const unread = new Set(['s1']);
    const trackerSource = {
      getSnapshot: () => new Map([['s1', { running: false, completionUnread: true }]]),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const tracker = createSideUnreadTracker(trackerSource);
    expect(tracker.getSnapshot().has('s1')).toBe(true);
    const registered: { options?: Record<string, unknown>; component?: unknown } = {};
    const ctx = {
      slots: {
        inject: (_key: string, callback: () => () => void) => {
          callback();
        },
        register: (definition: Record<string, unknown>, component: unknown) => {
          registered.options = definition;
          registered.component = component;
          return () => undefined;
        },
      },
      sidebarRight: { openResource: () => undefined },
      sessions: { list: listDouble({ s1: false }) },
      unread: tracker,
    } as unknown as SideHistoryContext;
    const dispose = registerSideHistoryView(ctx, storeDouble([sideChat('c1', 's1', '花絮')]));
    const component = registered.component as (props: Record<string, unknown>) => unknown;
    const inject = registered.options?.inject as (() => Record<string, unknown>) | undefined;
    render(createElement(component as never, {
      openView: vi.fn(),
      completeViewRequest: vi.fn(),
      viewRequest: null,
      ...(inject?.() ?? {}),
    }));
    expect(screen.getByText('已完成')).toBeDefined();
    tracker.acknowledge('s1');
    // The view reads the tracker snapshot; unregistering remounts it below.
    await waitFor(() => expect(screen.queryByText('已完成')).toBeNull());
    expect(listeners.size).toBe(1);
    tracker.dispose();
    dispose();
  });
});
