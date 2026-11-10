// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceService, Thought } from '@alter/protocol';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { AlterDocumentView } from '../src/document/AlterDocumentView';
import type { AlterDoc } from '../src/document/types';
import { htmlToMarkdown } from '../vendor/ui-space/src/utils/markdown';
import {
  DocumentModelUnavailableError,
  convertThoughtToDocument,
  createDocumentFromHtml,
} from '../vendor/ui-space/src/thought-conversion';

afterEach(() => cleanup());

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

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

function renderView(node: Record<string, unknown>) {
  const { value } = makeContext();
  render(
    createElement(
      SpaceContext.Provider,
      { value: value as never },
      createElement(AlterDocumentView, { node: node as never }),
    ),
  );
  return value;
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

  it('renders the structured view for any note, regardless of stored content', async () => {
    const { node } = makeContext();
    // A note whose stored content is still rich text must not fall back to a
    // second editor: every note renders the AST view.
    renderView({ ...node, content: '<p>旧正文</p>', contentFormat: undefined });
    await waitFor(() => {
      expect(
        document.querySelector('article[data-doc-format="alter-doc/1"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[data-doc-editor="tiptap"]'),
      ).toBeTruthy();
      expect(screen.getByText('编辑器正文')).toBeTruthy();
    });
    expect(document.querySelector('[data-doc-editor="tiptap"] .ProseMirror'))
      .toBeTruthy();
  });

  it('keeps the editor mounted across saves so undo history survives', async () => {
    const { value, node } = makeContext();
    render(
      createElement(
        SpaceContext.Provider,
        { value: value as never },
        createElement(AlterDocumentView, { node: node as never }),
      ),
    );
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    const surface = document.querySelector(
      '[data-doc-editor="tiptap"] .ProseMirror',
    );
    expect(surface).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '插入分割线' }));
    await waitFor(() => expect(screen.getByText('未保存')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(screen.getAllByText('revision 3').length).toBeGreaterThan(0),
    );

    // The save echo updates the snapshot but must not recreate the surface
    // (a revision-keyed editor used to remount and drop the undo history).
    expect(
      document.querySelector('[data-doc-editor="tiptap"] .ProseMirror'),
    ).toBe(surface);
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe('document view wiring', () => {
  it('routes every vendored document view through the structured component', () => {
    for (const file of [
      'vendor/ui-space/src/SpaceApp.tsx',
      'vendor/ui-space/src/SpaceWorkbench.tsx',
    ]) {
      const text = source(file);
      expect(text).toContain("from '@alter-space/document-view'");
      expect(text).not.toContain('views/DocumentView');
    }
    const spaceApp = source('vendor/ui-space/src/SpaceApp.tsx');
    expect(spaceApp).toContain('<DocumentView key={node.id} node={node} />');
    expect(source('vendor/ui-space/src/SpaceWorkbench.tsx')).not.toContain(
      'embedded',
    );
  });

  it('has no adaptive document view and no build-time override', () => {
    expect(
      existsSync(path.join(root, 'src', 'document', 'adaptive-document-view.tsx')),
    ).toBe(false);
    expect(
      existsSync(path.join(root, 'build', 'document-view-override.mjs')),
    ).toBe(false);
    const build = source('build/build.mjs');
    expect(build).toContain('@alter-space\\/document-view');
    expect(build).not.toContain('document-view-override');
    const tsconfig = JSON.parse(source('tsconfig.json')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(
      tsconfig.compilerOptions.paths['@alter-space/document-view'],
    ).toEqual(['src/document/AlterDocumentView.tsx']);
  });
});

describe('thought → document conversion', () => {
  it('converts rich-text editor output to Markdown', () => {
    expect(
      htmlToMarkdown(
        '<p>想法一</p><p><strong>重点</strong> 与 <a href="https://example.com">链接</a></p>',
      ),
    ).toBe('想法一\n\n**重点** 与 [链接](https://example.com)');
  });

  it('creates an empty AST note, then fills it through the document model', async () => {
    const events: string[] = [];
    const createNode = vi.fn(async () => {
      events.push('createNode');
      return { id: 'doc-new' };
    });
    const generate = vi.fn(async () => {
      events.push('generate');
      return {};
    });
    const service = {
      createNode,
      document: { generate },
    } as unknown as SpaceService;

    const node = await createDocumentFromHtml(service, {
      spaceId: 'sp-1',
      html: '<p>草稿正文</p>',
    });

    expect(node.id).toBe('doc-new');
    expect(createNode).toHaveBeenCalledWith({ spaceId: 'sp-1', kind: 'note' });
    expect(generate).toHaveBeenCalledWith({
      docId: 'doc-new',
      markdown: '草稿正文',
    });
    expect(events).toEqual(['createNode', 'generate']);
  });

  it('converts a thought through the document model with its content', async () => {
    const convertThought = vi.fn(async () => ({ node: { id: 'doc-conv' } }));
    const generate = vi.fn(async () => ({}));
    const service = {
      convertThought,
      document: { generate },
    } as unknown as SpaceService;
    const thought = {
      id: 'th-1',
      spaceId: 'sp-1',
      content: '<p>随想内容</p>',
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
      archived: false,
      archivedAt: null,
      deletedAt: null,
      convertedDocId: null,
    } as Thought;

    const node = await convertThoughtToDocument(service, thought);

    expect(node.id).toBe('doc-conv');
    expect(convertThought).toHaveBeenCalledWith('th-1');
    expect(generate).toHaveBeenCalledWith({
      docId: 'doc-conv',
      markdown: '随想内容',
    });
  });

  it('surfaces a visible error when the document model is not attached', async () => {
    const service = {} as unknown as SpaceService;
    await expect(
      createDocumentFromHtml(service, { spaceId: 'sp-1', html: '<p>x</p>' }),
    ).rejects.toBeInstanceOf(DocumentModelUnavailableError);
    await expect(
      convertThoughtToDocument(service, {
        id: 'th-1',
        content: '<p>x</p>',
      } as Thought),
    ).rejects.toThrow('文档模型客户端未装配');
  });
});
