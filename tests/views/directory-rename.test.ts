// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceNode, SpaceService } from '../../vendor/protocol/src';
import { SpaceContext } from '../../vendor/ui-space/src/runtime';
import type { SpaceContextValue } from '../../vendor/ui-space/src/runtime';
import { Directory } from '../../vendor/ui-space/src/components/Directory';

afterEach(() => cleanup());

const now = '2026-11-10T00:00:00.000Z';

const folder: SpaceNode = {
  id: 'n_folder',
  spaceId: 's1',
  kind: 'folder',
  title: '旧名称',
  parentId: null,
  creator: 'me',
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
  order: 0,
};

type SaveNode = (id: string, patch: { title: string }) => Promise<void>;

function context(saveNode: SaveNode): SpaceContextValue {
  return {
    service: { saveNode } as unknown as SpaceService,
    router: {
      getPath: () => '#/space/s1',
      subscribe: () => () => {},
      navigate: () => {},
    },
    spaces: [],
    agents: [],
    space: { id: 's1' } as never,
    spaceId: 's1',
    nodes: [folder],
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

/** Mirrors the sidebar: the folder enters rename mode from outside the row. */
function Harness({ saveNode }: { saveNode: SaveNode }) {
  const [renaming, setRenaming] = useState<SpaceNode | null>(folder);
  return createElement(
    SpaceContext.Provider,
    { value: context(saveNode) },
    createElement(Directory, {
      creator: 'me',
      viewMode: 'tree',
      showArchived: false,
      onCreateDoc: () => {},
      renameFolder: renaming,
      onRenameHandled: () => setRenaming(null),
    }),
  ) as ReactNode;
}

function renderRename() {
  const saveNode = vi.fn(async () => undefined);
  render(createElement(Harness, { saveNode }) as ReactNode);
  const input = screen.getByLabelText('文件夹名称') as HTMLInputElement;
  return { saveNode, input };
}

describe('folder rename with an IME', () => {
  it('commits the composition on Enter instead of saving the raw pinyin', async () => {
    const { saveNode, input } = renderRename();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'xinmingcheng' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    // The first Enter only confirms the IME candidate; the field stays in edit mode.
    expect(saveNode).not.toHaveBeenCalled();
    expect(screen.getByLabelText('文件夹名称')).toBe(input);

    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '新名称' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(saveNode).toHaveBeenCalledWith('n_folder', { title: '新名称' }),
    );
    expect(saveNode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText('文件夹名称')).toBeNull());
  });

  it('cancels the IME composition on Escape instead of closing the rename', () => {
    const { saveNode, input } = renderRename();

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(screen.getByLabelText('文件夹名称')).toBe(input);

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByLabelText('文件夹名称')).toBeNull();
    expect(saveNode).not.toHaveBeenCalled();
  });
});
