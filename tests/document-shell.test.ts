// @vitest-environment jsdom
/**
 * P1 document shell (jsdom): title textarea, breadcrumbs, document menu
 * (copy link / new child / export Markdown / archive), metadata, directory and
 * workbench entries, and the recordOpen read receipt.
 *
 * The shell wraps the P0 editor, so these tests mock `SpaceService` and the
 * document client and assert the shell wiring without touching save semantics
 * (covered by `document-ui.test.ts`).
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import { WorkbenchController } from '@alter/ui-workbench';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import { AlterDocumentView } from '../src/document/AlterDocumentView';
import type { AlterDoc } from '../src/document/types';

// jsdom has no layout engine; ProseMirror's scrollIntoView calls these on both
// elements and text ranges.
if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const secondDoc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    {
      id: 'blk_second',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '第二篇正文' }],
    },
  ],
};

function makeNode(overrides: Partial<SpaceNode> = {}): SpaceNode {
  return {
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
    unread: true,
    content: JSON.stringify(initialDoc),
    activity: 100,
    activityAt: '2026-11-09T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    order: 0,
    ...overrides,
  };
}

const folderNode = makeNode({
  id: 'folder-1',
  kind: 'folder',
  title: '项目文件夹',
  parentId: null,
  order: 0,
});
const parentNode = makeNode({
  id: 'doc-parent',
  title: '父文档',
  parentId: 'folder-1',
  order: 0,
});
const currentNode = makeNode({ parentId: 'doc-parent', order: 0 });

function snapshotFor(docId: string) {
  if (docId === 'doc-2') {
    return {
      docId,
      revision: 1,
      title: '第二篇',
      doc: secondDoc,
    };
  }
  return {
    docId,
    revision: 2,
    title: 'UI 文档',
    doc: initialDoc,
  };
}

interface HarnessOptions {
  get?: (docId: string) => Promise<unknown>;
  read?: (docId: string, options?: unknown) => Promise<unknown>;
  saveNode?: (id: string, patch: unknown) => Promise<unknown>;
  recordOpen?: (id: string) => Promise<unknown>;
  createNode?: (input: unknown) => Promise<unknown>;
  setArchived?: (id: string, archived: boolean) => Promise<unknown>;
  snapshotTitle?: string;
  nodes?: SpaceNode[];
  workbench?: { controller: WorkbenchController; scopeKey: string };
}

function makeHarness(options: HarnessOptions = {}) {
  const snapshot = {
    docId: 'doc-ui',
    revision: 2,
    title: options.snapshotTitle ?? 'UI 文档',
    doc: initialDoc,
  };
  const get = vi.fn(
    options.get ??
      (async (docId: string) =>
        docId === 'doc-2'
          ? snapshotFor('doc-2')
          : { ...snapshot, docId }),
  );
  const read = vi.fn(
    options.read ??
      (async () => ({
        docId: 'doc-ui',
        revision: 2,
        title: 'UI 文档',
        markdown: '# 测试文档\n\n编辑器正文\n',
        truncated: false,
      })),
  );
  const saveNode = vi.fn(options.saveNode ?? (async () => ({})));
  const recordOpen = vi.fn(
    options.recordOpen ?? (async (id: string) => makeNode({ id })),
  );
  const createNode = vi.fn(
    options.createNode ??
      (async () =>
        makeNode({ id: 'doc-child', title: '', parentId: 'doc-ui' })),
  );
  const setArchived = vi.fn(
    options.setArchived ??
      (async (id: string, archived: boolean) => makeNode({ id, archived })),
  );
  const navigate = vi.fn();
  const toast = vi.fn();
  const refresh = vi.fn();
  const addNodeToState = vi.fn();
  const applyOperations = vi.fn(async () => ({
    docId: 'doc-ui',
    revision: 3,
    changedBlockIds: [],
    diff: {},
    warnings: [],
  }));
  const client = {
    get,
    read,
    applyOperations,
    outline: vi.fn(async () => ({})),
    search: vi.fn(async () => ({ hits: [] })),
    undo: vi.fn(async () => ({})),
    restoreVersion: vi.fn(async () => ({ docId: 'doc-ui', revision: 3 })),
    generate: vi.fn(async () => ({})),
    getObject: vi.fn(async () => ({})),
  };
  const service = {
    document: client,
    saveNode,
    recordOpen,
    createNode,
    setArchived,
    listComments: vi.fn(async () => []),
    listVersions: vi.fn(async () => []),
    addComment: vi.fn(async () => ({})),
    resolveComment: vi.fn(async () => ({})),
  };
  const value = {
    service,
    router: {
      getPath: () => '#/space/sp-inbox/doc/doc-ui',
      subscribe: () => () => undefined,
      navigate,
    },
    spaces: [],
    agents: [],
    space: { id: 'sp-inbox', name: '收件箱' },
    spaceId: 'sp-inbox',
    nodes: options.nodes ?? [folderNode, parentNode, currentNode],
    thoughts: [],
    version: 0,
    refresh,
    toast,
    openSearch() {},
    openThoughtComposer() {},
    openDirectory() {},
    closeDirectory() {},
    removeSpaceFromState() {},
    addSpaceToState() {},
    addNodeToState,
    updateNodeInState() {},
    ...(options.workbench === undefined
      ? {}
      : { workbench: options.workbench }),
  };
  return {
    value,
    snapshot,
    get,
    read,
    saveNode,
    recordOpen,
    createNode,
    setArchived,
    navigate,
    toast,
    refresh,
    addNodeToState,
    client,
    service,
  };
}

function renderView(
  options: HarnessOptions = {},
  props: { node?: SpaceNode; embedded?: boolean } = {},
) {
  const harness = makeHarness(options);
  const node = props.node ?? currentNode;
  const element = () =>
    createElement(
      SpaceContext.Provider,
      { value: harness.value as never },
      createElement(AlterDocumentView, {
        node,
        ...(props.embedded === undefined ? {} : { embedded: props.embedded }),
      }),
    );
  const result = render(element());
  return { ...harness, node, ...result, rerenderWith: (next: SpaceNode) =>
    result.rerender(
      createElement(
        SpaceContext.Provider,
        { value: harness.value as never },
        createElement(AlterDocumentView, {
          node: next,
          ...(props.embedded === undefined ? {} : { embedded: props.embedded }),
        }),
      ),
    ) };
}

async function waitForEditor(): Promise<void> {
  await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
}

/** Flush React microtasks (load promise chains) while fake timers are active. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance fake timers and flush the work they trigger. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openDocumentMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
  await screen.findByRole('menu');
}

async function clickMenuItem(name: string): Promise<void> {
  const item = await screen.findByRole('menuitem', { name });
  fireEvent.click(item);
}

/** Make jsdom textarea metrics deterministic for the auto-grow title. */
function mockTextareaMetrics(initialHeight: number): {
  setHeight: (height: number) => void;
  restore: () => void;
} {
  let height = initialHeight;
  const previousClientWidth = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'clientWidth',
  );
  const previousScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'scrollHeight',
  );
  Object.defineProperty(HTMLTextAreaElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => height,
  });
  return {
    setHeight(next: number) {
      height = next;
    },
    restore() {
      if (previousClientWidth === undefined) {
        delete (HTMLTextAreaElement.prototype as { clientWidth?: unknown })
          .clientWidth;
      } else {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          'clientWidth',
          previousClientWidth,
        );
      }
      if (previousScrollHeight === undefined) {
        delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown })
          .scrollHeight;
      } else {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          'scrollHeight',
          previousScrollHeight,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

describe('document shell title', () => {
  it('renders a one-row auto-growing textarea with the 无标题 placeholder', async () => {
    const metrics = mockTextareaMetrics(52);
    try {
      renderView();
      const title = (await screen.findByLabelText(
        '文档标题',
      )) as HTMLTextAreaElement;
      expect(title.tagName).toBe('TEXTAREA');
      expect(title.rows).toBe(1);
      expect(title.placeholder).toBe('无标题');
      await waitFor(() => expect(title.style.height).toBe('52px'));

      // Growing content grows the textarea (no internal scrollbar).
      metrics.setHeight(88);
      fireEvent.change(title, {
        target: { value: '一个需要折行的很长很长的文档标题' },
      });
      await waitFor(() => expect(title.style.height).toBe('88px'));

      // Enter must not insert a newline.
      const notCancelled = fireEvent.keyDown(title, { key: 'Enter' });
      expect(notCancelled).toBe(false);
      expect(title.value).not.toContain('\n');
    } finally {
      metrics.restore();
    }
  });

  it('autosaves title edits through the existing debounce queue', async () => {
    vi.useFakeTimers();
    const { saveNode } = renderView();
    await settle();
    const title = screen.getByLabelText('文档标题');
    fireEvent.change(title, { target: { value: '  新标题  ' } });
    await tick(690);
    expect(saveNode).not.toHaveBeenCalled();
    await tick(30);
    await settle();
    expect(saveNode).toHaveBeenCalledTimes(1);
    expect(saveNode).toHaveBeenCalledWith('doc-ui', { title: '新标题' });
  });

  it('reverts an emptied title on blur to the loaded snapshot title', async () => {
    renderView();
    await waitForEditor();
    const title = screen.getByLabelText('文档标题') as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.blur(title);
    await waitFor(() => expect(title.value).toBe('UI 文档'));
  });
});

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

describe('document shell breadcrumbs', () => {
  it('renders space → ancestors → current title and navigates', async () => {
    const { navigate } = renderView();
    await waitForEditor();
    const nav = screen.getByRole('navigation', { name: '目录层级' });
    expect(nav.textContent).toContain('收件箱');
    expect(nav.textContent).toContain('项目文件夹');
    expect(nav.textContent).toContain('UI 文档');

    fireEvent.click(screen.getByRole('button', { name: '收件箱' }));
    expect(navigate).toHaveBeenCalledWith('#/space/sp-inbox/overview');

    fireEvent.click(screen.getByRole('button', { name: '父文档' }));
    expect(navigate).toHaveBeenCalledWith('#/space/sp-inbox/doc/doc-parent');

    // Folder ancestors are not navigable (old behaviour).
    expect(screen.queryByRole('button', { name: '项目文件夹' })).toBeNull();
  });

  it('shows 无标题 for an untitled document', async () => {
    renderView({ snapshotTitle: '' });
    await waitForEditor();
    const nav = screen.getByRole('navigation', { name: '目录层级' });
    expect(nav.textContent).toContain('无标题');
    const title = screen.getByLabelText('文档标题') as HTMLTextAreaElement;
    expect(title.value).toBe('');
    expect(title.placeholder).toBe('无标题');
  });
});

// ---------------------------------------------------------------------------
// Metadata / archive state
// ---------------------------------------------------------------------------

describe('document shell metadata', () => {
  it('shows creator, relative update time and revision', async () => {
    renderView();
    await waitForEditor();
    expect(screen.getByText('Alter 创建')).toBeTruthy();
    expect(screen.getByText(/更新$/)).toBeTruthy();
    expect(screen.getByText('revision 2')).toBeTruthy();
  });

  it('shows 我创建 for human-created documents', async () => {
    renderView({}, { node: makeNode({ creator: 'me' }) });
    await waitForEditor();
    expect(screen.getByText('我创建')).toBeTruthy();
  });

  it('shows the archived badge and 取消归档 entry for an archived document', async () => {
    renderView(
      {},
      {
        node: makeNode({
          archived: true,
          archivedBy: 'user',
          archivedAt: '2026-11-09T00:00:00.000Z',
        }),
      },
    );
    await waitForEditor();
    expect(screen.getByText('已归档')).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复文档' })).toBeTruthy();
    await openDocumentMenu();
    expect(
      await screen.findByRole('menuitem', { name: '取消归档' }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Document menu
// ---------------------------------------------------------------------------

describe('document menu', () => {
  it('copies the current document deep link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { toast } = renderView();
    await waitForEditor();
    await openDocumentMenu();
    await clickMenuItem('复制链接');
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}${window.location.pathname}#/space/sp-inbox/doc/doc-ui`,
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('链接已复制'));
  });

  it('opens the history tab from the document menu', async () => {
    renderView();
    await waitForEditor();
    await openDocumentMenu();
    await clickMenuItem('历史记录');
    await waitFor(() => {
      const tab = screen.getByRole('tab', { name: /历史/ });
      expect(tab.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('creates a child document and navigates to it', async () => {
    const { createNode, addNodeToState, navigate } = renderView();
    await waitForEditor();
    await openDocumentMenu();
    await clickMenuItem('新建子文档');
    await waitFor(() =>
      expect(createNode).toHaveBeenCalledWith({
        spaceId: 'sp-inbox',
        parentId: 'doc-ui',
        kind: 'note',
      }),
    );
    expect(addNodeToState).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('#/space/sp-inbox/doc/doc-child');
  });

  it('exports the Markdown projection as a .md download', async () => {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((value: Blob) => {
        blobs.push(value);
        return 'blob:mock';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        clicked = this;
      },
    );
    const { read, toast } = renderView();
    await waitForEditor();
    await openDocumentMenu();
    await clickMenuItem('导出 Markdown');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith('doc-ui', {
      anchors: false,
      maxChars: 40_000,
    });
    await waitFor(() => expect(clicked).not.toBeNull());
    expect(clicked!.download).toBe('UI 文档.md');
    const content = await blobs[0]!.text();
    expect(content).toContain('# UI 文档');
    expect(content).toContain('编辑器正文');
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Markdown 已导出'),
    );
  });

  it('archives from the menu and restores from the archived badge', async () => {
    const { setArchived, toast } = renderView();
    await waitForEditor();
    await openDocumentMenu();
    await clickMenuItem('归档');
    await waitFor(() =>
      expect(setArchived).toHaveBeenCalledWith('doc-ui', true),
    );
    await waitFor(() => expect(screen.getByText('已归档')).toBeTruthy());
    expect(toast).toHaveBeenCalledWith('已归档');

    fireEvent.click(screen.getByRole('button', { name: '恢复文档' }));
    await waitFor(() =>
      expect(setArchived).toHaveBeenCalledWith('doc-ui', false),
    );
    await waitFor(() => expect(screen.queryByText('已归档')).toBeNull());
    expect(toast).toHaveBeenCalledWith('已恢复');
  });
});

// ---------------------------------------------------------------------------
// Directory / workbench entries / recordOpen
// ---------------------------------------------------------------------------

describe('document shell entries', () => {
  it('renders the directory entry only for non-embedded documents', async () => {
    renderView();
    await waitForEditor();
    expect(
      screen.getByRole('button', { name: '打开空间目录' }),
    ).toBeTruthy();
    cleanup();

    renderView({}, { embedded: true });
    await waitForEditor();
    expect(
      screen.queryByRole('button', { name: '打开空间目录' }),
    ).toBeNull();
  });

  it('renders safely without a workbench controller', async () => {
    renderView();
    await waitForEditor();
    expect(screen.queryByRole('button', { name: '打开 Workbench' })).toBeNull();
    expect(screen.getByRole('button', { name: '文档菜单' })).toBeTruthy();
  });

  it('shows the workbench toggle when a controller is provided', async () => {
    const controller = new WorkbenchController();
    const scopeKey = 'doc:doc-ui';
    renderView({ workbench: { controller, scopeKey } });
    await waitForEditor();
    const toggle = await screen.findByRole('button', {
      name: '打开 Workbench',
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(controller.getScope(scopeKey).open).toBe(true));
    // The open workbench owns its toggle; the shell entry steps aside.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '打开 Workbench' })).toBeNull(),
    );
  });

  it('records the open document on mount and after switching', async () => {
    const { recordOpen, refresh, rerenderWith } = renderView();
    await waitFor(() => expect(recordOpen).toHaveBeenCalledWith('doc-ui'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    rerenderWith(makeNode({ id: 'doc-2', parentId: null, title: '第二篇' }));
    await waitFor(() => expect(recordOpen).toHaveBeenCalledWith('doc-2'));
    expect(recordOpen).toHaveBeenCalledTimes(2);
  });
});
