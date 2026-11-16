// @vitest-environment jsdom
/**
 * RelatedChatsDialog（相关会话弹层）的展示契约。
 *
 * 组件是纯展示件：列表由页面经桥拉取后传入，行为经回调交还。这里锁定
 * 徽标文案、无标题回退、侧边对话来源、失效引用置灰、空态与行内错误，
 * 以及行点击/删除按钮的回调分流。
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '../../../vendor/protocol/src/index';
import { RelatedChatsDialog } from '../../../vendor/ui-space/src/components/RelatedChatsDialog';

const now = new Date().toISOString();

function pageChat(): Chat {
  return {
    id: 'chat-1',
    kind: 'page',
    sessionId: 'sess-1',
    title: '鉴权方案讨论',
    sideOf: null,
    refs: [
      {
        id: 'ref-1',
        kind: 'page',
        spaceId: 'sp-1',
        nodeId: 'doc-1',
        label: '测试文档',
        addedAt: now,
        addedBy: 'me',
        state: 'current',
      },
      {
        id: 'ref-2',
        kind: 'page',
        spaceId: 'sp-1',
        nodeId: 'doc-9',
        label: '已删除页面',
        addedAt: now,
        addedBy: 'me',
        state: 'missing',
      },
    ],
    quote: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sideChat(): Chat {
  return {
    id: 'chat-2',
    kind: 'side',
    sessionId: 'sess-2',
    title: '',
    sideOf: { sessionId: 'sess-1', title: '主对话' },
    refs: [],
    quote: '某段引用',
    createdAt: now,
    updatedAt: now,
  };
}

interface RenderOptions {
  chats?: Chat[];
  loading?: boolean;
  error?: string | null;
  sessionGone?: (chat: Chat) => boolean;
}

function renderDialog(options: RenderOptions = {}) {
  const onClose = vi.fn();
  const onOpenChat = vi.fn();
  const onDeleteChat = vi.fn();
  render(
    createElement(RelatedChatsDialog, {
      open: true,
      chats: options.chats ?? [pageChat(), sideChat()],
      loading: options.loading,
      error: options.error ?? null,
      onClose,
      onOpenChat,
      onDeleteChat,
      sessionGone: options.sessionGone,
    } as never),
  );
  const dialog = screen.getByRole('dialog', { name: '相关会话' });
  return { onClose, onOpenChat, onDeleteChat, dialog };
}

afterEach(() => {
  cleanup();
});

describe('RelatedChatsDialog', () => {
  it('用 kind 徽标区分页面对话与侧边对话，空标题显示无标题', () => {
    const { dialog } = renderDialog();
    const scope = within(dialog);
    expect(scope.getByText('页面对话')).toBeTruthy();
    expect(scope.getByText('侧边对话')).toBeTruthy();
    expect(scope.getByText('鉴权方案讨论')).toBeTruthy();
    expect(scope.getByText('无标题')).toBeTruthy();
  });

  it('侧边对话显示分支来源，页面对话显示引用串与相对时间', () => {
    const { dialog } = renderDialog();
    const scope = within(dialog);
    expect(scope.getByText('分支自《主对话》')).toBeTruthy();
    expect(scope.getByText('测试文档')).toBeTruthy();
    // 刚生成的记录落在相对时间的「刚刚」一档。
    expect(scope.getAllByText('刚刚').length).toBe(2);
  });

  it('失效引用置灰加删除线，current 引用不受影响', () => {
    const { dialog } = renderDialog();
    const stale = within(dialog).getByText('已删除页面');
    expect(stale.getAttribute('data-stale')).toBe('true');
    const current = within(dialog).getByText('测试文档');
    expect(current.getAttribute('data-stale')).toBeNull();
  });

  it('行点击回调 openChat，删除按钮只回调 onDeleteChat', () => {
    const { onOpenChat, onDeleteChat } = renderDialog();
    fireEvent.click(screen.getByText('鉴权方案讨论'));
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    expect(onOpenChat.mock.calls[0]![0].id).toBe('chat-1');
    expect(onDeleteChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除对话 无标题' }));
    expect(onDeleteChat).toHaveBeenCalledWith('chat-2');
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('会话已从列表消失时标注「已删除」且不可打开，记录仍可删除', () => {
    const { onOpenChat, onDeleteChat } = renderDialog({
      chats: [pageChat(), sideChat()],
      sessionGone: (chat) => chat.id === 'chat-1',
    });
    expect(screen.getByText('已删除')).toBeTruthy();
    fireEvent.click(screen.getByText('鉴权方案讨论'));
    // 禁用的行不打开会话。
    expect(onOpenChat).not.toHaveBeenCalled();
    // 删除记录仍然可用（只是不能再打开）。
    fireEvent.click(screen.getByRole('button', { name: '删除对话 鉴权方案讨论' }));
    expect(onDeleteChat).toHaveBeenCalledWith('chat-1');
  });

  it('无会话时显示空态「暂无相关会话」', () => {
    const { dialog } = renderDialog({ chats: [] });
    expect(within(dialog).getByText('暂无相关会话')).toBeTruthy();
  });

  it('加载中与失败都在弹层内行内呈现', () => {
    const loading = renderDialog({ chats: [], loading: true });
    expect(within(loading.dialog).getByText('正在加载…')).toBeTruthy();
    cleanup();
    const failed = renderDialog({
      chats: [],
      error: '相关会话加载失败，请重试',
    });
    const alert = within(failed.dialog).getByRole('alert');
    expect(alert.textContent).toBe('相关会话加载失败，请重试');
  });
});
