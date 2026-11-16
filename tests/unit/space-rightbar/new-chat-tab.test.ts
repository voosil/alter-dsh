// @vitest-environment jsdom
/**
 * 「新建对话」 guide entry: which target it references.
 *
 * The entry sits in the right column, whose left side is the Space main panel.
 * The page the reader is on (main panel route) is what the new conversation
 * references; with no Space panel in the centre the entry falls back to the
 * default space its description promises.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spaceContinuity } from '../../../src/app/reload-continuity';
import { NewChatTab } from '../../../src/space-rightbar/NewChatTab';
import {
  setSpacePageServices,
  setUiBridge,
} from '../../../src/space-rightbar/context';

afterEach(() => {
  cleanup();
  setSpacePageServices(null);
  setUiBridge(null);
  const state = spaceContinuity();
  state.active = false;
  state.path = '#/space';
});

/** Minimal SpaceService double over the lookups the entry performs. */
function serviceDouble(options: {
  pages?: Record<string, { id: string; title: string }>;
  spaces?: { id: string; name: string; isDefault?: boolean }[];
}) {
  return {
    listSpaces: async () => options.spaces ?? [],
    getNode: async (id: string) => options.pages?.[id],
    getSpace: async (id: string) => (options.spaces ?? []).find((space) => space.id === id),
  };
}

/** Bridge double recording the reference the entry asks for. */
function installBridge() {
  const calls: { spaceId: string; nodeId: string | null; nodeTitle: string }[] = [];
  setUiBridge({
    toggleRightbar: () => 'toggled',
    startPageChat: async (input) => {
      calls.push({ spaceId: input.spaceId, nodeId: input.nodeId, nodeTitle: input.nodeTitle });
      return { id: 'chat-1', kind: 'page', sessionId: 'se_1' } as never;
    },
    relatedChats: async () => [],
    openPageInRightbar: () => undefined,
    openChat: () => undefined,
    deleteChat: async () => undefined,
  });
  return calls;
}

describe('NewChatTab', () => {
  it('references the page the Space main panel is showing', async () => {
    const continuity = spaceContinuity();
    continuity.active = true;
    continuity.path = '#/space/sp_1/doc/n-1';
    const calls = installBridge();
    setSpacePageServices({
      service: serviceDouble({
        pages: { 'n-1': { id: 'n-1', title: '页面标题' } },
        spaces: [{ id: 'sp_1', name: '空间一' }],
      }) as never,
    });
    render(createElement(NewChatTab));
    await waitFor(() => expect(screen.getByText('对话已创建，已在右侧以「对话」标签打开。')).toBeDefined());
    expect(calls).toEqual([{ spaceId: 'sp_1', nodeId: 'n-1', nodeTitle: '页面标题' }]);
  });

  it('references the open space when the panel is not on a page', async () => {
    const continuity = spaceContinuity();
    continuity.active = true;
    continuity.path = '#/space/sp_2/overview';
    const calls = installBridge();
    setSpacePageServices({
      service: serviceDouble({
        spaces: [
          { id: 'sp_1', name: '空间一', isDefault: true },
          { id: 'sp_2', name: '空间二' },
        ],
      }) as never,
    });
    render(createElement(NewChatTab));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ spaceId: 'sp_2', nodeId: null, nodeTitle: '空间二' });
  });

  it('falls back to the default space with no Space panel on screen', async () => {
    const calls = installBridge();
    setSpacePageServices({
      service: serviceDouble({
        spaces: [
          { id: 'sp_1', name: '空间一', isDefault: true },
          { id: 'sp_2', name: '空间二' },
        ],
      }) as never,
    });
    render(createElement(NewChatTab));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ spaceId: 'sp_1', nodeId: null, nodeTitle: '空间一' });
  });

  it('explains a missing space instead of creating anything', async () => {
    const calls = installBridge();
    setSpacePageServices({
      service: serviceDouble({ spaces: [] }) as never,
    });
    render(createElement(NewChatTab));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('还没有可用的空间'));
    expect(calls).toEqual([]);
  });

  it('reports an inline failure when the bridge is missing', async () => {
    setSpacePageServices({ service: serviceDouble({ spaces: [{ id: 'sp_1', name: '空间一' }] }) as never });
    render(createElement(NewChatTab));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('不可用'));
  });
});
