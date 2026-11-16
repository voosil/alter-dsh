// @vitest-environment jsdom
/**
 * 空间首页右上角的「右侧栏」开关（规范 4.1）。
 *
 * 空间主界面（空间首页/概览）也必须有和对话页一致的开关：点击经桥展开右栏，
 * 桥回答 `unavailable` 时行内说明原因，桥未装配时禁用。这里只渲染首页头部的
 * 这一个控件，其余上下文用替身。
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUiBridge } from '../../../vendor/ui-space/src/bridge';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import { SpaceHome } from '../../../vendor/ui-space/src/views/SpaceHome';

afterEach(() => {
  cleanup();
  setUiBridge(null);
});

/** Context double: only the faces SpaceHome reads are real. */
function contextDouble(overrides: Record<string, unknown> = {}) {
  const toast = vi.fn();
  const router = { getPath: () => '#/space/sp-1', subscribe: () => () => undefined, navigate: vi.fn() };
  const value = {
    service: {
      createNode: vi.fn(async () => ({ id: 'doc-new', spaceId: 'sp-1', title: '', kind: 'note' })),
    },
    router,
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间一' },
    spaceId: 'sp-1',
    nodes: [],
    thoughts: [],
    version: 0,
    refresh: vi.fn(),
    toast,
    openSearch: vi.fn(),
    openThoughtComposer: vi.fn(),
    openDirectory: vi.fn(),
    closeDirectory: vi.fn(),
    removeSpaceFromState: vi.fn(),
    addSpaceToState: vi.fn(),
    addNodeToState: vi.fn(),
    updateNodeInState: vi.fn(),
    ...overrides,
  };
  return { value, toast, router };
}

/** Full bridge double; only `toggleRightbar` matters here. */
function installBridge(outcome: 'toggled' | 'engaged' | 'unavailable' = 'toggled') {
  const toggleRightbar = vi.fn(async () => outcome);
  setUiBridge({
    toggleRightbar,
    startPageChat: vi.fn(async () => Promise.reject(new Error('unused'))),
    relatedChats: vi.fn(async () => []),
    openPageInRightbar: vi.fn(),
    openChat: vi.fn(),
    deleteChat: vi.fn(async () => undefined),
  } as never);
  return toggleRightbar;
}

const SWITCH = '展开/收起右侧栏';

describe('空间首页右侧栏开关', () => {
  it('渲染开关并把当前空间交给桥', async () => {
    const toggleRightbar = installBridge('engaged');
    render(
      createElement(
        SpaceContext.Provider,
        { value: contextDouble().value as never },
        createElement(SpaceHome),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() => {
      expect(toggleRightbar).toHaveBeenCalledWith({ spaceId: 'sp-1' });
    });
  });

  it('桥回答 unavailable 时行内说明原因', async () => {
    installBridge('unavailable');
    const context = contextDouble();
    render(
      createElement(
        SpaceContext.Provider,
        { value: context.value as never },
        createElement(SpaceHome),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() => {
      expect(context.toast).toHaveBeenCalledWith(
        '右侧栏需要对话视图；请在左侧会话列表打开一个对话后重试',
      );
    });
  });

  it('桥未装配时禁用', () => {
    setUiBridge(null);
    render(
      createElement(
        SpaceContext.Provider,
        { value: contextDouble().value as never },
        createElement(SpaceHome),
      ),
    );
    expect((screen.getByRole('button', { name: SWITCH }) as HTMLButtonElement).disabled).toBe(true);
  });
});
