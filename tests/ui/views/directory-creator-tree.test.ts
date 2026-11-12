// @vitest-environment jsdom
/**
 * Sidebar creator tabs vs. cross-creator nesting.
 *
 * The tabs group nodes by `creator`, but folders are shared containers: an
 * Agent-written document usually lives in a folder the user created. Filtering
 * rows by creator alone used to drop such a document from the tree in *both*
 * tabs (its parent was filtered out of the Alter tab, itself out of the user
 * tab), while the flat view showed it. The tree now filters over the whole
 * space tree and lets non-matching parents be transparent, so a matching node
 * attaches to its nearest visible ancestor instead of vanishing.
 */
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpaceNode, SpaceService } from '../../../vendor/protocol/src';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import type { SpaceContextValue } from '../../../vendor/ui-space/src/runtime';
import { Directory } from '../../../vendor/ui-space/src/components/Directory';

afterEach(() => cleanup());

const now = '2026-11-10T00:00:00.000Z';
let sequence = 0;

function makeNode(
  id: string,
  kind: SpaceNode['kind'],
  creator: SpaceNode['creator'],
  title: string,
  parentId: string | null,
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

function context(nodes: SpaceNode[]): SpaceContextValue {
  return {
    service: {} as SpaceService,
    router: {
      getPath: () => '#/space/s1',
      subscribe: () => () => {},
      navigate: () => {},
    },
    spaces: [],
    agents: [],
    space: { id: 's1' } as never,
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

function renderDirectory(nodes: SpaceNode[], creator: 'me' | 'alter') {
  return render(
    createElement(
      SpaceContext.Provider,
      { value: context(nodes) },
      createElement(Directory, {
        creator,
        viewMode: 'tree',
        showArchived: false,
        onCreateDoc: () => {},
      }),
    ),
  );
}

/** The row div of one rendered node (inline padding encodes the depth). */
function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest('button')?.parentElement;
  if (!(row instanceof HTMLElement)) throw new Error(`row not found: ${title}`);
  return row;
}

describe('sidebar creator tabs keep cross-creator nesting visible', () => {
  it('promotes an Alter document out of user folders to the Alter tab root', () => {
    renderDirectory(
      [
        makeNode('n_me_folder', 'folder', 'me', '我的资料夹', null),
        makeNode('n_me_sub', 'folder', 'me', '我的子目录', 'n_me_folder'),
        makeNode('n_alter_doc', 'note', 'alter', 'AI 写的文档', 'n_me_sub'),
        makeNode('n_me_note', 'note', 'me', '我的笔记', null),
      ],
      'alter',
    );
    expect(screen.getByText('AI 写的文档')).toBeTruthy();
    expect(screen.queryByText('我的资料夹')).toBeNull();
    expect(screen.queryByText('我的子目录')).toBeNull();
    expect(screen.queryByText('我的笔记')).toBeNull();
    // Two hidden ancestors add no depth: the row sits at the tab root.
    expect(rowOf('AI 写的文档').style.paddingLeft).toBe('0px');
  });

  it('keeps Alter folders and their children nested in the Alter tab', () => {
    renderDirectory(
      [
        makeNode('n_alter_folder', 'folder', 'alter', 'AI 文件夹', null),
        makeNode('n_alter_child', 'note', 'alter', 'AI 子文档', 'n_alter_folder'),
        makeNode('n_me_note', 'note', 'me', '我的笔记', null),
      ],
      'alter',
    );
    expect(rowOf('AI 文件夹').style.paddingLeft).toBe('0px');
    expect(rowOf('AI 子文档').style.paddingLeft).toBe('13px');
    expect(screen.queryByText('我的笔记')).toBeNull();
  });

  it('keeps the user tab to user-created rows', () => {
    renderDirectory(
      [
        makeNode('n_me_folder', 'folder', 'me', '我的资料夹', null),
        makeNode('n_alter_doc', 'note', 'alter', 'AI 写的文档', 'n_me_folder'),
        makeNode('n_alter_folder', 'folder', 'alter', 'AI 文件夹', null),
        makeNode(
          'n_me_doc',
          'note',
          'me',
          '我写在 AI 文件夹里的笔记',
          'n_alter_folder',
        ),
      ],
      'me',
    );
    expect(screen.getByText('我的资料夹')).toBeTruthy();
    expect(screen.queryByText('AI 写的文档')).toBeNull();
    // Mirrored case: an Agent folder holding a user note is transparent too.
    expect(screen.getByText('我写在 AI 文件夹里的笔记')).toBeTruthy();
    expect(screen.queryByText('AI 文件夹')).toBeNull();
  });
});