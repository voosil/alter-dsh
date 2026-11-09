// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { AlterDocumentView } from '../src/document/AlterDocumentView';
import type { AlterDoc } from '../src/document/types';

afterEach(() => cleanup());

const initialDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 2,
  blocks: [
    {
      id: 'blk_h',
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: '测试文档' }],
    },
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '编辑器正文' }],
    },
  ],
};

const versionDoc: AlterDoc = {
  ...initialDoc,
  revision: 1,
};

function makeContext() {
  const client = {
    async get() {
      return { docId: 'doc-ui', revision: 2, title: 'UI 文档', doc: initialDoc };
    },
    async applyOperations() {
      return {
        docId: 'doc-ui',
        revision: 3,
        changedBlockIds: [],
        diff: {},
        warnings: [],
      };
    },
    async restoreVersion() {
      return { docId: 'doc-ui', revision: 3 };
    },
    async read() {
      return { markdown: '# 测试文档\n\n编辑器正文\n', revision: 2 };
    },
  };
  const service = {
    document: client,
    async listComments() {
      return [
        {
          id: 'cm_1',
          docId: 'doc-ui',
          author: 'me',
          body: '侧栏评论内容',
          quote: null,
          status: 'open',
          createdAt: '2026-11-09T00:00:00.000Z',
          resolvedAt: null,
          editedAt: null,
          supplements: [],
        },
      ];
    },
    async listVersions() {
      return [
        {
          id: 'ver_1',
          docId: 'doc-ui',
          title: 'UI 文档',
          content: JSON.stringify(versionDoc),
          author: 'me',
          at: '2026-11-09T00:00:00.000Z',
        },
      ];
    },
    async addComment() {
      return {};
    },
    async resolveComment() {
      return {};
    },
    async saveNode() {
      return {};
    },
  };
  const value = {
    service,
    router: {},
    spaces: [],
    agents: [],
    space: { id: 'sp-inbox' },
    spaceId: 'sp-inbox',
    nodes: [],
    thoughts: [],
    version: 0,
    refresh() {},
    toast() {},
    openSearch() {},
    openThoughtComposer() {},
    openDirectory() {},
    closeDirectory() {},
    removeSpaceFromState() {},
    addSpaceToState() {},
    addNodeToState() {},
    updateNodeInState() {},
  };
  const node = {
    id: 'doc-ui',
    spaceId: 'sp-inbox',
    kind: 'note',
    title: 'UI 文档',
    parentId: null,
    creator: 'alter',
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: JSON.stringify(initialDoc),
    activity: 100,
    activityAt: '2026-11-09T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    order: 0,
  };
  return { value, node };
}

describe('AST document UI integration', () => {
  it('mounts the Tiptap editor with the loaded document', async () => {
    const { value, node } = makeContext();
    render(
      createElement(
        SpaceContext.Provider,
        { value: value as never },
        createElement(AlterDocumentView, { node: node as never }),
      ),
    );
    await waitFor(() => {
      expect(screen.getByDisplayValue('UI 文档')).toBeTruthy();
      expect(screen.getByText('编辑器正文')).toBeTruthy();
      expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    });
  });

  it('opens the comments/history side panel and loads metadata', async () => {
    const { value, node } = makeContext();
    render(
      createElement(
        SpaceContext.Provider,
        { value: value as never },
        createElement(AlterDocumentView, { node: node as never }),
      ),
    );
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '评论与历史' }));
    await waitFor(() => {
      expect(screen.getByText('侧栏评论内容')).toBeTruthy();
      expect(screen.getByPlaceholderText('写下评论…')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('tab', { name: /历史/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '恢复此版本' })).toBeTruthy();
    });
  });
});
