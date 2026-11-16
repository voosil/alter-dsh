// @vitest-environment jsdom
/**
 * Side-chat conversation surfaces.
 *
 * E1: the selection surface renders two parallel actions (the shipped quote
 * kept beside the side-chat branch), and the assistant action resolves the
 * reply's own prose from the Chat snapshot. D: the branch records the main
 * conversation's display title. F: history rows map the session list's running
 * bit onto a marker, and guess nothing when the list has no row.
 *
 * The DSH slot runtime is replaced by structural doubles: no DSH module is
 * loaded and no browser surface outside jsdom is touched.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@alter/protocol';
import {
  SIDE_ASSISTANT_ACTIONS_SLOT,
  SIDE_ASSISTANT_ACTION_ORDER,
  SIDE_CHAT_INTERACTION_ID,
  SIDE_TEXT_INTERACTION_SLOT,
  SideChatAssistantAction,
  SideChatSelectionAction,
  chatSourceLabel,
  createSideChatLauncher,
  registerSideInteraction,
  resolveAssistantQuote,
  sideChatSourceTitle,
  sideSurfaceActions,
  type SideAssistantNode,
  type SideChatAssistantActionProps,
  type SideChatSelector,
  type SideChatSelectionActionProps,
  type SideChatSnapshot,
  type SideSessionSnapshot,
  type SideSessionSelector,
} from '../../../src/space-conversation/side';
import { sideRowStatus, sideRowStatusLabel } from '../../../src/space-conversation/side-history';

afterEach(() => {
  cleanup();
});

/** A writable main conversation, as the session standard hook reports it. */
const WRITABLE: SideSessionSnapshot = {
  sessionId: 'main-1',
  removed: false,
  running: false,
  blank: false,
  promptAttempted: true,
  awaitingFirstTurn: false,
  openState: 'open',
  subagent: null,
};

/** The same conversation as a non-continuable subagent (no side chats). */
const SUBAGENT: SideSessionSnapshot = {
  ...WRITABLE,
  subagent: { address: { mode: 'one-shot' } },
};

/** The same conversation removed from the session catalog. */
const REMOVED: SideSessionSnapshot = { ...WRITABLE, removed: true };

/** Session selector double bound to one fixed snapshot. */
function selectorOf(snapshot: SideSessionSnapshot): SideSessionSelector {
  return <T,>(selector: (value: SideSessionSnapshot) => T): T => selector(snapshot);
}

/** Chat snapshot double carrying the given nodes. */
function chatSelectorOf(nodes: readonly SideAssistantNode[]): SideChatSelector {
  const snapshot: SideChatSnapshot = { nodes: { values: () => nodes } };
  return <T,>(selector: (value: SideChatSnapshot) => T): T => selector(snapshot);
}

/** One assistant row payload as the Chat store publishes it. */
function assistantNode(messageId: string, texts: readonly string[]): SideAssistantNode {
  return {
    data: {
      blocks: texts.map((text) => ({ kind: 'text', text })),
      finalNode: { messageId },
    },
  };
}

/** One Turn-tail payload whose closing reply carries the given message id. */
function tailNode(messageId: string, texts: readonly string[]): SideAssistantNode {
  return {
    data: {
      closing: {
        blocks: texts.map((text) => ({ kind: 'text', text })),
        finalNode: { messageId },
      },
    },
  };
}

describe('sideSurfaceActions', () => {
  it('enables both actions for a writable conversation with a selection', () => {
    expect(sideSurfaceActions({ writable: true, readText: () => '选中的文字' })).toEqual({
      visible: true,
      quoteEnabled: true,
      sideChatEnabled: true,
    });
  });

  it('disables both actions when the surface holds no selection', () => {
    expect(sideSurfaceActions({ writable: true, readText: () => null })).toEqual({
      visible: true,
      quoteEnabled: false,
      sideChatEnabled: false,
    });
  });

  it('treats a blank selection as nothing to act on', () => {
    expect(sideSurfaceActions({ writable: true, readText: () => '   \n\t ' })).toEqual({
      visible: true,
      quoteEnabled: false,
      sideChatEnabled: false,
    });
  });

  it('renders nothing in a conversation that cannot be written', () => {
    expect(sideSurfaceActions({ writable: false, readText: () => '选中的文字' })).toEqual({
      visible: false,
      quoteEnabled: false,
      sideChatEnabled: false,
    });
  });
});

describe('resolveAssistantQuote', () => {
  it('prefers the closing reply a Turn tail owns', () => {
    const nodes = [
      assistantNode('m-1', ['前半句']),
      tailNode('m-1', ['整条回复']),
    ];
    expect(resolveAssistantQuote(nodes, 'm-1')).toBe('整条回复');
  });

  it('falls back to the assistant row carrying the same durable message', () => {
    expect(resolveAssistantQuote([assistantNode('m-2', ['回复正文'])], 'm-2')).toBe('回复正文');
  });

  it('joins paragraphs with a blank line and trims the result', () => {
    expect(resolveAssistantQuote([assistantNode('m-3', [' 第一段 ', '第二段 '])], 'm-3')).toBe(
      '第一段\n\n第二段',
    );
  });

  it('quotes nothing when the reply carries no prose', () => {
    expect(resolveAssistantQuote([
      { data: { blocks: [{ kind: 'reasoning', text: '思考' }], finalNode: { messageId: 'm-4' } } },
    ], 'm-4')).toBeNull();
    expect(resolveAssistantQuote([assistantNode('m-5', [])], 'm-5')).toBeNull();
  });

  it('quotes nothing for a message the snapshot does not hold', () => {
    expect(resolveAssistantQuote([assistantNode('m-6', ['回复'])], 'other')).toBeNull();
    expect(resolveAssistantQuote([], 'm-6')).toBeNull();
  });
});

describe('chatSourceLabel', () => {
  it('names the main conversation when the branch recorded its title', () => {
    expect(chatSourceLabel({ sideOf: { sessionId: 'main-1', title: '重构计划' } })).toBe(
      '分支自《重构计划》',
    );
  });

  it('falls back to the generic copy for a record without a title', () => {
    expect(chatSourceLabel({ sideOf: { sessionId: 'main-1', title: '' } })).toBe('分支自主对话');
    expect(chatSourceLabel({ sideOf: null })).toBe('分支自主对话');
    expect(chatSourceLabel(undefined)).toBe('分支自主对话');
  });
});

describe('sideChatSourceTitle', () => {
  it('reads the session list display title', () => {
    expect(sideChatSourceTitle({
      getSnapshot: () => ({ byId: { 'main-1': { displayTitle: '重构计划' } } }),
    }, 'main-1')).toBe('重构计划');
  });

  it('treats an id-shaped display title as no title', () => {
    expect(sideChatSourceTitle({
      getSnapshot: () => ({ byId: { 'main-1': { displayTitle: 'main-1' } } }),
    }, 'main-1')).toBeUndefined();
  });

  it('reads nothing without a list or a row', () => {
    expect(sideChatSourceTitle(undefined, 'main-1')).toBeUndefined();
    expect(sideChatSourceTitle({ getSnapshot: () => ({ byId: {} }) }, 'main-1')).toBeUndefined();
    expect(sideChatSourceTitle({
      getSnapshot: () => ({ byId: { 'main-1': { displayTitle: '   ' } } }),
    }, 'main-1')).toBeUndefined();
  });
});

describe('createSideChatLauncher', () => {
  const record: Chat = {
    id: 'chat-1',
    kind: 'side',
    sessionId: 'child-1',
    title: '',
    sideOf: null,
    refs: [],
    quote: '选中的文字',
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
  };

  it('records the main conversation display title on the branch', async () => {
    const fork = vi.fn(async () => 'child-1');
    const openResource = vi.fn();
    const createSideChat = vi.fn(async (input: {
      sessionId: string;
      sideOf: { sessionId: string; title: string };
      quote?: string | null;
    }) => ({ ...record, sessionId: input.sessionId, sideOf: input.sideOf }));
    const launch = createSideChatLauncher({
      sessions: {
        fork,
        list: { getSnapshot: () => ({ byId: { 'main-1': { displayTitle: '重构计划' } } }) },
      },
      sidebarRight: { openResource },
    }, createSideChat);
    await expect(launch('main-1', '选中的文字')).resolves.toBe('child-1');
    expect(createSideChat).toHaveBeenCalledWith({
      sessionId: 'child-1',
      sideOf: { sessionId: 'main-1', title: '重构计划' },
      quote: '选中的文字',
    });
    expect(openResource).toHaveBeenCalledWith(
      'dsh-resource://spacechat/session/child-1',
      { kind: 'alter-space.side' },
    );
  });

  it('records an empty title when the session list is unavailable', async () => {
    const createSideChat = vi.fn(async (input: {
      sessionId: string;
      sideOf: { sessionId: string; title: string };
      quote?: string | null;
    }) => ({ ...record, sideOf: input.sideOf }));
    const launch = createSideChatLauncher({
      sessions: { fork: async () => 'child-1' },
      sidebarRight: { openResource: () => undefined },
    }, createSideChat);
    await launch('main-1', '选中的文字');
    expect(createSideChat).toHaveBeenCalledWith({
      sessionId: 'child-1',
      sideOf: { sessionId: 'main-1', title: '' },
      quote: '选中的文字',
    });
  });

  it('lets a caller inject the title lookup', async () => {
    const createSideChat = vi.fn(async (input: {
      sessionId: string;
      sideOf: { sessionId: string; title: string };
      quote?: string | null;
    }) => ({ ...record, sideOf: input.sideOf }));
    const launch = createSideChatLauncher({
      sessions: { fork: async () => 'child-1' },
      sidebarRight: { openResource: () => undefined },
    }, createSideChat, { readTitle: () => '注入的标题' });
    await launch('main-1', '选中的文字');
    expect(createSideChat.mock.calls[0]?.[0].sideOf).toEqual(
      { sessionId: 'main-1', title: '注入的标题' },
    );
  });
});

describe('sideRowStatus', () => {
  it('marks a running session and an idle one', () => {
    expect(sideRowStatus(true)).toBe('running');
    expect(sideRowStatus(false)).toBe('idle');
  });

  it('marks a stopped session whose completion has not been seen', () => {
    expect(sideRowStatus(false, true)).toBe('completed');
    // A running branch never reads as completed: the run in progress wins.
    expect(sideRowStatus(true, true)).toBe('running');
  });

  it('marks nothing when the list has no running state', () => {
    expect(sideRowStatus(undefined)).toBe('unknown');
    expect(sideRowStatus(undefined, true)).toBe('unknown');
  });

  it('labels the three markers and leaves the unknown one empty', () => {
    expect(sideRowStatusLabel('running')).toBe('生成中');
    expect(sideRowStatusLabel('completed')).toBe('已完成');
    expect(sideRowStatusLabel('idle')).toBe('空闲');
    expect(sideRowStatusLabel('unknown')).toBe('');
  });
});

describe('registerSideInteraction', () => {
  /** Client context double recording every registration it receives. */
  function contextDouble() {
    const injected: string[] = [];
    const registers: { options: Record<string, unknown> }[] = [];
    const interactionDispose = vi.fn();
    const ctx = {
      slots: {
        inject: vi.fn((key: string, callback: () => () => void) => {
          injected.push(key);
          callback();
        }),
        register: vi.fn((options: Record<string, unknown>, _component: unknown) => {
          registers.push({ options });
          return () => undefined;
        }),
      },
      sessions: { binding: () => undefined },
      uiConversation: { interactions: { register: vi.fn(() => interactionDispose) } },
    };
    return { ctx, injected, registers, interactionDispose };
  }

  it('registers the two-button surface and the assistant action', () => {
    const { ctx, injected, registers } = contextDouble();
    registerSideInteraction(ctx, async () => 'child-1');
    expect(injected).toEqual([SIDE_TEXT_INTERACTION_SLOT, SIDE_ASSISTANT_ACTIONS_SLOT]);
    expect(ctx.uiConversation.interactions.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: SIDE_CHAT_INTERACTION_ID }),
    );
    expect(registers[0]?.options).toMatchObject({
      name: SIDE_TEXT_INTERACTION_SLOT,
      key: SIDE_CHAT_INTERACTION_ID,
    });
    expect(registers[1]?.options).toMatchObject({
      name: SIDE_ASSISTANT_ACTIONS_SLOT,
      id: SIDE_CHAT_INTERACTION_ID,
      order: SIDE_ASSISTANT_ACTION_ORDER,
    });
  });

  it('disposes the interaction with its two surfaces', () => {
    const { ctx, interactionDispose } = contextDouble();
    const dispose = registerSideInteraction(ctx, async () => 'child-1');
    dispose();
    expect(interactionDispose).toHaveBeenCalledTimes(1);
  });
});

describe('SideChatSelectionAction', () => {
  function renderSelection(overrides: Partial<SideChatSelectionActionProps> = {}) {
    const dismiss = vi.fn();
    const readText = vi.fn(() => '选中的文字');
    const clearSelection = vi.fn();
    const insertQuote = vi.fn(() => true);
    const startSideChat = vi.fn(async () => 'child-1');
    render(createElement(SideChatSelectionAction, {
      sessionId: 'main-1',
      useSession: selectorOf(WRITABLE),
      dismiss,
      readText,
      clearSelection,
      inputActions: { insertQuote },
      startSideChat,
      ...overrides,
    }));
    return { dismiss, readText, clearSelection, insertQuote, startSideChat };
  }

  it('renders the quote action beside the side-chat action', () => {
    renderSelection();
    expect(screen.getByRole('button', { name: '引用文本' })).toBeDefined();
    expect(screen.getByRole('button', { name: '在侧边对话中引用' })).toBeDefined();
  });

  it('keeps the shipped quote behaviour: insert, clear, dismiss', () => {
    const spies = renderSelection();
    fireEvent.click(screen.getByRole('button', { name: '引用文本' }));
    expect(spies.insertQuote).toHaveBeenCalledWith('选中的文字');
    expect(spies.clearSelection).toHaveBeenCalled();
    expect(spies.dismiss).toHaveBeenCalled();
    expect(spies.startSideChat).not.toHaveBeenCalled();
  });

  it('keeps the surface open when the composer refuses the quote', () => {
    const spies = renderSelection({ inputActions: { insertQuote: () => false } });
    fireEvent.click(screen.getByRole('button', { name: '引用文本' }));
    expect(spies.clearSelection).not.toHaveBeenCalled();
    expect(spies.dismiss).not.toHaveBeenCalled();
  });

  it('branches the selection through the side-chat action', async () => {
    const spies = renderSelection();
    fireEvent.click(screen.getByRole('button', { name: '在侧边对话中引用' }));
    expect(spies.startSideChat).toHaveBeenCalledWith('main-1', '选中的文字');
    await waitFor(() => expect(spies.dismiss).toHaveBeenCalled());
    expect(spies.clearSelection).toHaveBeenCalled();
    expect(spies.insertQuote).not.toHaveBeenCalled();
  });

  it('disables both actions without a selection', () => {
    renderSelection({ readText: () => null });
    expect(screen.getByRole('button', { name: '引用文本' }).hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: '在侧边对话中引用' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('renders nothing and dismisses for an unwritable conversation', () => {
    const dismiss = vi.fn();
    renderSelection({
      useSession: selectorOf(SUBAGENT),
      dismiss,
    });
    expect(screen.queryByRole('button', { name: '引用文本' })).toBeNull();
    expect(dismiss).toHaveBeenCalled();
  });
});

describe('SideChatAssistantAction', () => {
  function renderAssistant(overrides: Partial<SideChatAssistantActionProps> = {}) {
    const startSideChat = vi.fn(async () => 'child-1');
    render(createElement(SideChatAssistantAction, {
      sessionId: 'main-1',
      useSession: selectorOf(WRITABLE),
      messageId: 'm-1',
      useChat: chatSelectorOf([tailNode('m-1', ['整条回复'])]),
      startSideChat,
      ...overrides,
    }));
    return { startSideChat };
  }

  it('branches the whole reply as the quoted text', async () => {
    const spies = renderAssistant();
    fireEvent.click(screen.getByRole('button', { name: '在侧边对话中引用' }));
    expect(spies.startSideChat).toHaveBeenCalledWith('main-1', '整条回复');
    await waitFor(() => expect(spies.startSideChat).toHaveBeenCalled());
  });

  it('renders nothing for an unwritable conversation', () => {
    renderAssistant({ useSession: selectorOf(REMOVED) });
    expect(screen.queryByRole('button', { name: '在侧边对话中引用' })).toBeNull();
  });

  it('renders nothing when the reply has no quotable prose', () => {
    renderAssistant({
      useChat: chatSelectorOf([
        { data: { blocks: [{ kind: 'tool-call' }], finalNode: { messageId: 'm-1' } } },
      ]),
    });
    expect(screen.queryByRole('button', { name: '在侧边对话中引用' })).toBeNull();
  });
});
