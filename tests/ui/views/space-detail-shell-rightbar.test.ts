// @vitest-environment jsdom
/**
 * 空间主界面（概览/活动/配置等）的右侧栏开关（规范 4.1）。
 *
 * 「空间主界面」默认落在概览页，由 `SpaceDetailShell` 提供头部；页面与空间首页
 * 都有开关，概览页同样必须有——否则读者在默认落地页上根本打不开右栏。这里渲染
 * 真实 shell，只替身上下文与 hub 数据。
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUiBridge } from '../../../vendor/ui-space/src/bridge';
import { HubContext } from '../../../vendor/ui-space/src/hub/context';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import { SpaceDetailShell } from '../../../vendor/ui-space/src/views/SpaceDetailShell';

afterEach(() => {
  cleanup();
  setUiBridge(null);
});

/** Hub snapshot double: the shell reads the plugin roster and waiting matters. */
function hubSnapshot() {
  return {
    matters: [],
    journey: { vision: '', shortTerm: '', longTerm: '' },
    observations: [],
    plugins: [{ id: 'overview', label: '概览', enabled: true, builtin: true }],
    policy: 'ask',
    onboarding: 'complete',
    summary: { content: '', updatedAt: '' },
    usage: [],
  };
}

/** Space context double for the shell. */
function spaceContext() {
  return {
    service: { getOverview: vi.fn(async () => undefined) },
    router: { navigate: vi.fn(), getPath: () => '#/space/sp-1/overview', subscribe: () => () => undefined },
    space: { id: 'sp-1', name: '空间一' },
    spaceId: 'sp-1',
    spaces: [],
    agents: [],
    nodes: [],
    thoughts: [],
    version: 0,
    refresh: vi.fn(),
    toast: vi.fn(),
    openSearch: vi.fn(),
    openThoughtComposer: vi.fn(),
    openDirectory: vi.fn(),
    closeDirectory: vi.fn(),
    removeSpaceFromState: vi.fn(),
    addSpaceToState: vi.fn(),
    addNodeToState: vi.fn(),
    updateNodeInState: vi.fn(),
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

/** Render the shell around a trivial page. */
function renderShell(overrides: Record<string, unknown> = {}) {
  render(
    createElement(
      SpaceContext.Provider,
      { value: { ...spaceContext(), ...overrides } as never },
      createElement(
        HubContext.Provider,
        { value: hubSnapshot() as never },
        createElement(
          SpaceDetailShell,
          { active: 'overview' } as never,
          createElement('p', {}, '空间概览'),
        ),
      ),
    ),
  );
}

const SWITCH = '展开/收起右侧栏';

describe('空间主界面右侧栏开关', () => {
  it('概览页头部渲染开关并把当前空间交给桥', async () => {
    const toggleRightbar = installBridge('toggled');
    renderShell();
    expect(screen.getByText('空间概览')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() => expect(toggleRightbar).toHaveBeenCalledWith({ spaceId: 'sp-1' }));
  });

  it('桥未装配时禁用', () => {
    setUiBridge(null);
    renderShell();
    expect((screen.getByRole('button', { name: SWITCH }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('嵌入态不渲染（右栏标签里的空间视图）', () => {
    installBridge('toggled');
    renderShell({ embedded: true });
    expect(screen.queryByRole('button', { name: SWITCH })).toBeNull();
  });
});
