// @vitest-environment jsdom
/**
 * P2 version history: AST block diff, diff preview rendering, restore flow and
 * the large-diff / unparseable-version guards.
 *
 * `service.listVersions` is owned by the side panel; these tests render
 * `HistoryView` directly with a version list and mock the document client.
 */
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocVersion } from '@alter/protocol';
import { SpaceRemoteError, type SpaceDocumentClient } from '../src/space-client';
import { HistoryView } from '../src/document/history/HistoryView';
import {
  EMPTY_ALTER_DOC,
  MAX_DIFF_ENTRIES,
  attrLabel,
  blockExcerpt,
  blockTypeLabel,
  blockTypeName,
  changedAttrs,
  diffAlterDocs,
  documentsEquivalent,
} from '../src/document/history/diff';
import {
  describeRestoreError,
  readHistorySnapshot,
  readRestoredRevision,
} from '../src/document/history/snapshot';
import type { AlterDoc, BlockNode } from '../src/document/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function textBlock(
  id: string,
  text: string,
  type = 'paragraph',
  attrs: Record<string, unknown> = {},
): BlockNode {
  return {
    id,
    type,
    attrs: attrs as BlockNode['attrs'],
    content: [{ type: 'text', text }],
  };
}

function heading(id: string, text: string, level = 1): BlockNode {
  return textBlock(id, text, 'heading', { level });
}

function atomBlock(id: string, type: string, attrs: Record<string, unknown>): BlockNode {
  return { id, type, attrs: attrs as BlockNode['attrs'] };
}

function makeDoc(blocks: BlockNode[], revision = 1): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision, blocks };
}

interface VersionOptions {
  title?: string;
  author?: 'me' | 'alter';
  at?: string;
}

function makeVersion(
  id: string,
  doc: AlterDoc,
  options: VersionOptions = {},
): DocVersion {
  return {
    id,
    docId: 'doc-1',
    title: options.title ?? '文档标题',
    content: JSON.stringify(doc),
    author: options.author ?? 'me',
    at: options.at ?? '2026-11-09T10:00:00.000Z',
  };
}

function makeSnapshot(doc: AlterDoc, title = '当前标题', revision = 2) {
  return { docId: 'doc-1', revision, title, doc };
}

interface ClientOptions {
  get?: (docId: string) => Promise<unknown>;
  restoreVersion?: (input: {
    docId: string;
    versionId: string;
    baseRevision: number;
  }) => Promise<unknown>;
}

function makeClient(options: ClientOptions = {}) {
  const get = vi.fn(
    options.get ?? (async () => makeSnapshot(makeDoc([textBlock('p1', '当前正文')]))),
  );
  const restoreVersion = vi.fn(
    options.restoreVersion ??
      (async () => ({ docId: 'doc-1', revision: 3 })),
  );
  return {
    client: { get, restoreVersion } as unknown as SpaceDocumentClient,
    get,
    restoreVersion,
  };
}

function entryItems(): HTMLElement[] {
  const list = screen.getByRole('list', { name: '逐块差异' });
  return within(list).getAllByRole('listitem');
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

describe('block diff engine', () => {
  it('summarizes added / removed / modified blocks with previews', () => {
    const base = makeDoc([
      textBlock('p1', '第一段'),
      heading('h1', '旧标题'),
      textBlock('p2', '将被删除'),
    ]);
    const target = makeDoc([
      textBlock('p1', '第一段'),
      heading('h1', '新标题'),
      textBlock('p3', '新增段落'),
    ]);

    const diff = diffAlterDocs(base, target);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.modified).toBe(1);
    expect(diff.moved).toBe(0);
    expect(diff.total).toBe(3);
    expect(diff.truncated).toBe(false);
    expect(diff.baseBlocks).toBe(3);
    expect(diff.targetBlocks).toBe(3);

    const modified = diff.entries.find((entry) => entry.kind === 'modified');
    expect(modified).toMatchObject({
      blockId: 'h1',
      type: 'heading',
      typeLabel: '标题 H1',
      text: '新标题',
      previousText: '旧标题',
      index: 2,
    });
    const added = diff.entries.find((entry) => entry.kind === 'added');
    expect(added).toMatchObject({ blockId: 'p3', text: '新增段落', typeLabel: '正文' });
    const removed = diff.entries.find((entry) => entry.kind === 'removed');
    expect(removed).toMatchObject({ blockId: 'p2', text: '将被删除', index: 3 });
  });

  it('detects moved blocks by stable block id', () => {
    const base = makeDoc([textBlock('p1', '一'), textBlock('p2', '二')]);
    const target = makeDoc([textBlock('p2', '二'), textBlock('p1', '一')]);
    const diff = diffAlterDocs(base, target);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.modified).toBe(0);
    expect(diff.moved).toBe(2);
    expect(diff.entries.map((entry) => entry.kind)).toEqual(['moved', 'moved']);
  });

  it('reports changed attrs and attr title previews', () => {
    const base = makeDoc([
      atomBlock('b1', 'bookmark', { url: 'https://example.com', title: '旧标题' }),
    ]);
    const target = makeDoc([
      atomBlock('b1', 'bookmark', { url: 'https://example.com', title: '新标题' }),
    ]);
    const diff = diffAlterDocs(base, target);
    expect(diff.modified).toBe(1);
    expect(diff.entries[0]).toMatchObject({
      kind: 'modified',
      title: '新标题',
      changedAttrs: ['title'],
    });
    expect(blockTypeName('bookmark')).toBe('网页链接卡');
    expect(blockTypeLabel(base.blocks[0]!)).toBe('网页链接卡');
    expect(attrLabel('title')).toBe('标题');
    expect(changedAttrs(base.blocks[0]!, target.blocks[0]!)).toEqual(['title']);
  });

  it('falls back to the raw type name and summarizes nested text', () => {
    const nested: BlockNode = {
      id: 'list-1',
      type: 'bulletList',
      attrs: {},
      children: [
        {
          id: 'item-1',
          type: 'listItem',
          attrs: {},
          content: [{ type: 'text', text: '列表内容' }],
        },
      ],
    };
    expect(blockExcerpt(nested)).toBe('列表内容');
    expect(blockTypeName('futureBlock')).toBe('futureBlock');
    expect(blockTypeLabel(nested)).toBe('无序列表');
  });

  it('truncates large diffs and keeps the full total', () => {
    const target = makeDoc(
      Array.from({ length: 150 }, (_, index) =>
        textBlock(`p${index}`, `段落 ${index}`),
      ),
    );
    const diff = diffAlterDocs(EMPTY_ALTER_DOC, target);
    expect(diff.added).toBe(150);
    expect(diff.total).toBe(150);
    expect(diff.entries).toHaveLength(MAX_DIFF_ENTRIES);
    expect(diff.truncated).toBe(true);

    const capped = diffAlterDocs(EMPTY_ALTER_DOC, target, { maxEntries: 5 });
    expect(capped.entries).toHaveLength(5);
    expect(capped.total).toBe(150);
    expect(capped.truncated).toBe(true);
    expect(capped.maxEntries).toBe(5);
  });

  it('reports no entries for identical documents', () => {
    const doc = makeDoc([textBlock('p1', '同一段')]);
    const diff = diffAlterDocs(doc, doc);
    expect(diff.total).toBe(0);
    expect(diff.entries).toEqual([]);
    expect(diff.truncated).toBe(false);
    expect(documentsEquivalent(doc, doc)).toBe(true);
    expect(
      documentsEquivalent(doc, makeDoc([textBlock('p1', '不同段')])),
    ).toBe(false);
    expect(documentsEquivalent(doc, makeDoc([]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

describe('history snapshot helpers', () => {
  it('reads a valid doc.get snapshot and rejects foreign shapes', () => {
    const doc = makeDoc([textBlock('p1', '正文')]);
    expect(readHistorySnapshot(makeSnapshot(doc, '标题', 4))).toEqual({
      doc,
      revision: 4,
      title: '标题',
    });
    expect(readHistorySnapshot({ docId: 'doc-1', revision: 4, doc })).toEqual({
      doc,
      revision: 4,
      title: '',
    });
    expect(
      readHistorySnapshot({ docId: 'doc-1', revision: '4', doc }),
    ).toBeUndefined();
    expect(readHistorySnapshot(null)).toBeUndefined();
    expect(readHistorySnapshot({ doc: { format: 'html' }, revision: 1 })).toBeUndefined();
  });

  it('reads restore revisions and maps restore errors readably', () => {
    expect(readRestoredRevision({ revision: 7 })).toBe(7);
    expect(readRestoredRevision({ revision: -1 })).toBeUndefined();
    expect(readRestoredRevision('bad')).toBeUndefined();
    expect(
      describeRestoreError(new SpaceRemoteError('doc/conflict', '冲突')),
    ).toContain('revision 冲突');
    expect(
      describeRestoreError(new SpaceRemoteError('op/invalid', '版本内容损坏')),
    ).toBe('版本无法恢复：版本内容损坏');
    expect(describeRestoreError(new Error('网络不可用'))).toBe('网络不可用');
    expect(describeRestoreError('unknown')).toBe('恢复失败，请重试。');
  });
});

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------

describe('version history view', () => {
  it('renders the version list (author, time, title) and selects the newest', async () => {
    const older = makeVersion(
      'ver-1',
      makeDoc([textBlock('p1', '旧正文')]),
      { title: '旧标题', author: 'me', at: '2026-11-08T09:00:00.000Z' },
    );
    const newer = makeVersion(
      'ver-2',
      makeDoc([textBlock('p1', '旧正文'), textBlock('p2', '新增正文')]),
      { title: '新标题', author: 'alter', at: '2026-11-09T10:00:00.000Z' },
    );
    const { client } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
    });
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [newer, older],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    const list = screen.getByRole('list', { name: '版本列表' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('Alter');
    expect(list.textContent).toContain('新标题');
    expect(list.textContent).toContain('我');
    expect(list.textContent).toContain('旧标题');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Alter · 新标题/ }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('orders versions newest-first even when the list is unsorted', async () => {
    const older = makeVersion('ver-1', makeDoc([textBlock('p1', '旧正文')]), {
      title: '旧标题',
      author: 'me',
      at: '2026-11-08T09:00:00.000Z',
    });
    const newer = makeVersion('ver-2', makeDoc([textBlock('p1', '旧正文'), textBlock('p2', '新增正文')]), {
      title: '新标题',
      author: 'alter',
      at: '2026-11-09T10:00:00.000Z',
    });
    const { client } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
    });
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [older, newer],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    const list = screen.getByRole('list', { name: '版本列表' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('新标题');
    expect(rows[1]!.textContent).toContain('旧标题');
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /Alter · 新标题/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    // Newest is selected, so the diff base is the older snapshot.
    expect(screen.getByText('新增 1')).toBeTruthy();
  });

  it('shows the diff summary, title diff and per-block entries', async () => {
    const older = makeVersion(
      'ver-1',
      makeDoc([textBlock('p1', '旧正文'), textBlock('p2', '将被删除')]),
      { title: '旧标题' },
    );
    const newer = makeVersion(
      'ver-2',
      makeDoc([textBlock('p1', '旧正文'), heading('h2', '新标题块')]),
      { title: '新标题' },
    );
    const { client } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
    });
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [newer, older],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    await waitFor(() => expect(screen.getByText('新增 1')).toBeTruthy());
    expect(screen.getByText('删除 1')).toBeTruthy();
    expect(screen.getByText('修改 0')).toBeTruthy();
    expect(screen.getByText('旧标题')).toBeTruthy();
    expect(screen.getByText('新标题')).toBeTruthy();

    const entries = entryItems();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.textContent).toContain('新增');
    expect(entries[0]!.textContent).toContain('标题 H1');
    expect(entries[0]!.textContent).toContain('新标题块');
    expect(entries[1]!.textContent).toContain('删除');
    expect(entries[1]!.textContent).toContain('将被删除');
  });

  it('marks unparseable versions and disables restore', async () => {
    const broken: DocVersion = {
      id: 'ver-broken',
      docId: 'doc-1',
      title: '旧格式',
      content: '<p>旧 HTML 正文</p>',
      author: 'me',
      at: '2026-11-09T10:00:00.000Z',
    };
    const { client } = makeClient();
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [broken],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/该版本内容无法解析/)).toBeTruthy(),
    );
    const restore = screen.getByRole('button', {
      name: '恢复此版本',
    }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(screen.queryByRole('list', { name: '逐块差异' })).toBeNull();
  });

  it('disables restore when the version already equals the current document', async () => {
    const doc = makeDoc([textBlock('p1', '同一内容')]);
    const version = makeVersion('ver-1', doc, { title: '同一标题' });
    const { client } = makeClient({
      get: async () => makeSnapshot(doc, '同一标题', 3),
    });
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 3,
        versions: [version],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/该版本与当前文档一致/)).toBeTruthy(),
    );
    expect(
      (screen.getByRole('button', { name: '恢复此版本' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('restores with the editor revision as CAS base and reports success', async () => {
    const older = makeVersion('ver-1', makeDoc([textBlock('p1', '旧正文')]), {
      title: '旧标题',
    });
    const newer = makeVersion('ver-2', makeDoc([textBlock('p1', '新正文')]), {
      title: '新标题',
    });
    const { client, restoreVersion } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
      restoreVersion: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    const onRestored = vi.fn();
    const onReloadVersions = vi.fn(async () => undefined);
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 7,
        versions: [newer, older],
        client,
        onRestored,
        onReloadVersions,
      }),
    );

    const restore = await screen.findByRole('button', { name: '恢复此版本' });
    fireEvent.click(restore);
    await waitFor(() =>
      expect(restoreVersion).toHaveBeenCalledWith({
        docId: 'doc-1',
        versionId: 'ver-2',
        baseRevision: 7,
      }),
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(8));
    expect(onReloadVersions).toHaveBeenCalledTimes(1);
    expect(screen.getByText('已恢复到该版本')).toBeTruthy();
  });

  it('surfaces a readable restore failure and does not call onRestored', async () => {
    const version = makeVersion('ver-1', makeDoc([textBlock('p1', '旧正文')]));
    const { client } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
      restoreVersion: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
    });
    const onRestored = vi.fn();
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [version],
        client,
        onRestored,
        onReloadVersions: async () => undefined,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '恢复此版本' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        '文档已被修改（revision 冲突）',
      ),
    );
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('keeps working when the current document cannot be read', async () => {
    const version = makeVersion('ver-1', makeDoc([textBlock('p1', '旧正文')]));
    const { client } = makeClient({
      get: async () => {
        throw new Error('网络不可用');
      },
    });
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [version],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/网络不可用（仍可尝试恢复）/)).toBeTruthy(),
    );
    expect(
      (screen.getByRole('button', { name: '恢复此版本' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('truncates a huge diff in the UI and shows the total', async () => {
    const older = makeVersion('ver-1', makeDoc([]));
    const newer = makeVersion(
      'ver-2',
      makeDoc(
        Array.from({ length: 150 }, (_, index) =>
          textBlock(`p${index}`, `段落 ${index}`),
        ),
      ),
    );
    const { client } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
    });
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 2,
        versions: [newer, older],
        client,
        onRestored: () => undefined,
        onReloadVersions: async () => undefined,
      }),
    );

    await waitFor(() => expect(screen.getByText('新增 150')).toBeTruthy());
    expect(entryItems()).toHaveLength(MAX_DIFF_ENTRIES);
    expect(
      screen.getByText(`仅显示前 ${MAX_DIFF_ENTRIES} 条，共 150 条变更。`),
    ).toBeTruthy();
  });

  it('restores a large document through one RPC call', async () => {
    const older = makeVersion('ver-1', makeDoc([]));
    const large = makeVersion(
      'ver-2',
      makeDoc(
        Array.from({ length: 300 }, (_, index) =>
          textBlock(`p${index}`, `段落 ${index}`),
        ),
      ),
    );
    const { client, restoreVersion } = makeClient({
      get: async () => makeSnapshot(makeDoc([textBlock('p9', '当前正文')])),
      restoreVersion: async () => ({ docId: 'doc-1', revision: 9 }),
    });
    const onRestored = vi.fn();
    render(
      createElement(HistoryView, {
        docId: 'doc-1',
        revision: 8,
        versions: [large, older],
        client,
        onRestored,
        onReloadVersions: async () => undefined,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '恢复此版本' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(9));
    expect(restoreVersion).toHaveBeenCalledTimes(1);
    expect(restoreVersion).toHaveBeenCalledWith({
      docId: 'doc-1',
      versionId: 'ver-2',
      baseRevision: 8,
    });
  });
});
