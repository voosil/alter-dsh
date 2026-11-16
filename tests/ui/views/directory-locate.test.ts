// @vitest-environment jsdom
/**
 * Directory locates the open document.
 *
 * Two things make the sidebar point at a document that was opened for the user
 * (default-document redirect, a link from chat, a deep link): the creator tab
 * has to follow the open document, and its row has to be in sight even when a
 * folder above it is collapsed.
 *
 * The tab used to latch on `lastDocRef` before looking the document up, so a
 * route that resolved before `listNodes` returned left an Agent-written
 * document open with the "我创建的" tab selected and the row nowhere.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceNode, SpaceService } from '../../../vendor/protocol/src';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import type { SpaceContextValue } from '../../../vendor/ui-space/src/runtime';
import { Directory } from '../../../vendor/ui-space/src/components/Directory';
import { Sidebar } from '../../../vendor/ui-space/src/components/Sidebar';

afterEach(() => cleanup());

const now = '2026-11-13T00:00:00.000Z';
let sequence = 0;

function makeNode(
  id: string,
  kind: SpaceNode['kind'],
  creator: SpaceNode['creator'],
  title: string,
  parentId: string | null = null,
): SpaceNode {
  sequence += 1;
  return {
    id,
    spaceId: 's1',
    kind,
    title,
    parentId,
    creator,
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: '',
    activity: 0,
    activityAt: now,
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: now,
    updatedAt: now,
    order: sequence,
  };
}

const ALTER_DOC = makeNode('n_alter_doc', 'note', 'alter', 'AI 写的文档');
const USER_DOC = makeNode('n_me_doc', 'note', 'me', '我的笔记');

function context(nodes: SpaceNode[], path = '#/space/s1'): SpaceContextValue {
  return {
    service: {
      listDeleted: async () => ({ nodes: [], thoughts: [] }),
    } as unknown as SpaceService,
    router: {
      getPath: () => path,
      subscribe: () => () => {},
      navigate: () => {},
    },
    spaces: [],
    agents: [],
    space: { id: 's1', name: '空间' } as never,
    spaceId: 's1',
    nodes,
    thoughts: [],
    version: 0,
    refresh: () => {},
    toast: () => {},
    openSearch: () => {},
    openThoughtComposer: () => {},
    openDirectory: () => {},
    closeDirectory: () => {},
    removeSpaceFromState: () => {},
    addSpaceToState: () => {},
    addNodeToState: () => {},
    updateNodeInState: () => {},
  } as unknown as SpaceContextValue;
}

function renderSidebar(nodes: SpaceNode[], path: string) {
  return render(
    createElement(
      SpaceContext.Provider,
      { value: context(nodes, path) },
      createElement(Sidebar, {
        open: true,
        onClose: () => {},
        onCreateSpace: () => {},
      }),
    ),
  );
}

function tab(label: string): HTMLElement {
  const element = screen.getByRole('tab', { name: new RegExp(label) });
  return element;
}

function renderDirectory(nodes: SpaceNode[], selectedId?: string) {
  const element = createElement(
    SpaceContext.Provider,
    { value: context(nodes) },
    createElement(Directory, {
      creator: 'alter',
      viewMode: 'tree',
      showArchived: false,
      selectedId,
      onCreateDoc: () => {},
    }),
  );
  const rendered = render(element);
  return {
    ...rendered,
    rerenderWith(selected: string | undefined) {
      rendered.rerender(
        createElement(
          SpaceContext.Provider,
          { value: context(nodes) },
          createElement(Directory, {
            creator: 'alter',
            viewMode: 'tree',
            showArchived: false,
            selectedId: selected,
            onCreateDoc: () => {},
          }),
        ),
      );
    },
  };
}

describe('sidebar creator tab follows the open document', () => {
  it('selects the Alter tab when the document list arrives after the route', () => {
    // Deep link / default-document redirect: the route is on the document while
    // `listNodes` is still in flight.
    const routed = renderSidebar([USER_DOC], '#/space/s1/doc/n_alter_doc');
    expect(tab('我创建的').getAttribute('aria-selected')).toBe('true');

    routed.rerender(
      createElement(
        SpaceContext.Provider,
        {
          value: context(
            [USER_DOC, ALTER_DOC],
            '#/space/s1/doc/n_alter_doc',
          ),
        },
        createElement(Sidebar, {
          open: true,
          onClose: () => {},
          onCreateSpace: () => {},
        }),
      ),
    );

    expect(tab('Alter 创建的').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('AI 写的文档')).toBeTruthy();
    expect(screen.queryByText('我的笔记')).toBeNull();
  });

  it('selects the user tab for a user document', () => {
    renderSidebar([USER_DOC, ALTER_DOC], '#/space/s1/doc/n_me_doc');
    expect(tab('我创建的').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('我的笔记')).toBeTruthy();
  });
});

describe('directory keeps the open document in sight', () => {
  beforeEach(() => {
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = () => undefined;
    }
  });

  it('scrolls the active row into view', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    spy.mockClear();
    renderDirectory([ALTER_DOC, USER_DOC], 'n_alter_doc');
    const row = screen.getByText('AI 写的文档').closest('[data-active]');
    expect(row).not.toBeNull();
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
    expect(spy.mock.contexts).toContain(row);
    spy.mockRestore();
  });

  it('re-opens a collapsed ancestor so the active row exists', () => {
    const folder = makeNode('n_alter_folder', 'folder', 'alter', 'AI 文件夹');
    const child = makeNode(
      'n_alter_child',
      'note',
      'alter',
      'AI 子文档',
      'n_alter_folder',
    );
    const view = renderDirectory([folder, child]);
    fireEvent.click(screen.getByLabelText('收起'));
    expect(screen.queryByText('AI 子文档')).toBeNull();

    view.rerenderWith('n_alter_child');
    expect(screen.getByText('AI 子文档')).toBeTruthy();
    expect(
      screen.getByText('AI 子文档').closest('[data-active]'),
    ).not.toBeNull();
  });
});
