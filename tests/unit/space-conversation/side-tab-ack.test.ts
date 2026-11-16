// @vitest-environment jsdom
/**
 * 侧边对话 tab body: the unread acknowledgement.
 *
 * The history row raises 「已完成」 and the branch tab clears it: a visible tab
 * is the user seeing the branch, so a completion that lands while the tab is in
 * front of them never becomes a marker. A tab the column keeps mounted but
 * hidden must not acknowledge anything.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SideChatTab,
  registerSideChatTab,
  type SideChatStoreSource,
  type SideChatTabProps,
} from '../../../src/space-conversation/side-tab';
import type { SideUnreadStore } from '../../../src/space-conversation/side-status';

afterEach(() => {
  cleanup();
});

const ADDRESS = 'dsh-resource://spacechat/session/sess-1';

/** Chat store double with one record lookup. */
function storeDouble(): SideChatStoreSource {
  const record = {
    id: 'chat-1',
    kind: 'side' as const,
    sessionId: 'sess-1',
    title: '花絮',
    sideOf: { sessionId: 'main-1', title: '主对话' },
    refs: [],
    quote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    chatSourceOfSession: () => ({
      getSnapshot: () => record,
      subscribe: () => () => undefined,
    }),
  };
}

/** Unread store double whose snapshot the test controls. */
function unreadDouble(initial: readonly string[]) {
  const unread = new Set(initial);
  // A stable snapshot identity keeps useSyncExternalStore out of a render loop.
  let snapshot: ReadonlySet<string> = new Set(unread);
  const listeners = new Set<() => void>();
  const acknowledge = vi.fn((sessionId: string) => {
    if (!unread.delete(sessionId)) return;
    snapshot = new Set(unread);
    for (const listener of listeners) listener();
  });
  const store: SideUnreadStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acknowledge,
  };
  return { store, acknowledge, unread };
}

/**
 * Register the tab type with doubles and return the body it registered plus the
 * acknowledgement spy the registration injected into the store.
 */
function registerTab(unread: SideUnreadStore) {
  const components: Record<string, unknown> = {};
  const ctx = {
    slots: {
      // The seat lives in another plugin; the double runs the inject callback now.
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (definition: Record<string, unknown>, component: unknown) => {
        components[String(definition.name)] = component;
        return () => undefined;
      },
    },
    sessions: {
      retain: () => ({ sessionId: 'sess-1', ready: Promise.resolve(), release: () => undefined }),
    },
    sidebarRightTabs: { register: () => () => undefined },
    resources: { register: () => () => undefined },
    unread,
  };
  const dispose = registerSideChatTab(ctx, storeDouble());
  return { dispose, component: components['sidebar.right.pane.tab'] };
}

/** Props the seat composes for one body occurrence. */
function tabProps(visible: boolean): SideChatTabProps {
  return {
    useTabInfo: () => ({
      tab: {
        id: 'tab-1',
        kind: 'alter-space.side',
        contentId: ADDRESS,
        title: '侧边对话 sess-1',
        visible,
        navigation: { address: ADDRESS, params: undefined, revision: 0 },
        signal: new AbortController().signal,
      },
    }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
    SessionProvider: () => null,
    renderSlot: () => null,
  } as SideChatTabProps;
}

describe('SideChatTab banner', () => {
  it('shows the one-line branch source above the conversation', () => {
    const unread = unreadDouble([]);
    const { component, dispose } = registerTab(unread.store);
    const Body = component as (props: SideChatTabProps) => unknown;
    render(createElement(Body as never, tabProps(false)));
    expect(screen.getByText('分支自《主对话》')).toBeTruthy();
    dispose();
  });
});

describe('SideChatTab unread acknowledgement', () => {
  it('acknowledges a visible tab holding an unread branch', () => {
    const unread = unreadDouble(['sess-1']);
    const { component, dispose } = registerTab(unread.store);
    const Body = component as (props: SideChatTabProps) => unknown;
    render(createElement(Body as never, tabProps(true)));
    expect(unread.acknowledge).toHaveBeenCalledWith('sess-1');
    expect(unread.unread.has('sess-1')).toBe(false);
    dispose();
  });

  it('leaves a visible tab alone when the branch is already read', () => {
    const unread = unreadDouble([]);
    const { component, dispose } = registerTab(unread.store);
    const Body = component as (props: SideChatTabProps) => unknown;
    render(createElement(Body as never, tabProps(true)));
    expect(unread.acknowledge).not.toHaveBeenCalled();
    dispose();
  });

  it('does not acknowledge a tab the column keeps mounted but hidden', () => {
    const unread = unreadDouble(['sess-1']);
    const { component, dispose } = registerTab(unread.store);
    const Body = component as (props: SideChatTabProps) => unknown;
    render(createElement(Body as never, tabProps(false)));
    expect(unread.acknowledge).not.toHaveBeenCalled();
    dispose();
  });

  it('acknowledges when a hidden unread tab becomes visible', () => {
    const unread = unreadDouble(['sess-1']);
    const { component, dispose } = registerTab(unread.store);
    const Body = component as (props: SideChatTabProps) => unknown;
    const { rerender } = render(createElement(Body as never, tabProps(false)));
    expect(unread.acknowledge).not.toHaveBeenCalled();
    rerender(createElement(Body as never, tabProps(true)));
    expect(unread.acknowledge).toHaveBeenCalledWith('sess-1');
    dispose();
  });
});
