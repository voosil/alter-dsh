// @vitest-environment jsdom
/**
 * 共享的「右侧栏」开关（`components/RightbarButton.tsx`）。
 *
 * 空间主界面各视图和页面共用同一个控件：它切换的是 DSH 的右侧栏，不是空间自建
 * 的面板。嵌入在右栏标签里的视图不渲染它；桥未装配时禁用；桥回答 `unavailable`
 * 时行内说明原因。
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUiBridge } from '../../../vendor/ui-space/src/bridge';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import { RightbarButton } from '../../../vendor/ui-space/src/components/RightbarButton';

afterEach(() => {
  cleanup();
  setUiBridge(null);
});

/** Context double with the switch's inputs. */
function contextValue(overrides: Record<string, unknown> = {}) {
  const toast = vi.fn();
  return {
    value: {
      service: {},
      router: { navigate: vi.fn() },
      space: { id: 'sp-1', name: '空间一' },
      spaceId: 'sp-1',
      spaces: [],
      agents: [],
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
    },
    toast,
  };
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

/** Render the button under a context. */
function renderButton(props: { nodeId?: string; embedded?: boolean } = {}, overrides: Record<string, unknown> = {}) {
  const context = contextValue(overrides);
  render(
    createElement(
      SpaceContext.Provider,
      { value: context.value as never },
      createElement(RightbarButton, props),
    ),
  );
  return context;
}

const SWITCH = '展开/收起右侧栏';

describe('RightbarButton', () => {
  it('toggles the right column for the current space', async () => {
    const toggleRightbar = installBridge('toggled');
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() => expect(toggleRightbar).toHaveBeenCalledWith({ spaceId: 'sp-1' }));
  });

  it('carries the open page when there is one', async () => {
    const toggleRightbar = installBridge('engaged');
    renderButton({ nodeId: 'doc-1' });
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() =>
      expect(toggleRightbar).toHaveBeenCalledWith({ spaceId: 'sp-1', nodeId: 'doc-1' }),
    );
  });

  it('explains an unavailable column instead of doing nothing', async () => {
    installBridge('unavailable');
    const context = renderButton();
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() =>
      expect(context.toast).toHaveBeenCalledWith(
        '右侧栏需要对话视图；请在左侧会话列表打开一个对话后重试',
      ),
    );
  });

  it('is disabled while no bridge is installed', () => {
    setUiBridge(null);
    renderButton();
    expect((screen.getByRole('button', { name: SWITCH }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not render inside a right-column tab (context or explicit)', () => {
    installBridge('toggled');
    renderButton({}, { embedded: true });
    expect(screen.queryByRole('button', { name: SWITCH })).toBeNull();
    cleanup();
    renderButton({ embedded: true });
    expect(screen.queryByRole('button', { name: SWITCH })).toBeNull();
  });
});
