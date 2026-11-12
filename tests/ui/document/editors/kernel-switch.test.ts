// @vitest-environment jsdom
/**
 * The document page honours the kernel preference.
 *
 * Parity gate at the wiring level: selecting the AST-native kernel must mount
 * it, load the same document, and put an edit into the save pipeline as AST
 * blocks — without changing the surrounding page or the default (legacy).
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../../../../vendor/ui-space/src/runtime';
import { DocumentView } from '../../../../vendor/ui-space/src/views/DocumentView';
import {
  DEFAULT_EDITOR_KERNEL,
  EDITOR_KERNEL_PREFERENCE_KEY,
  readEditorKernelPreference,
  writeEditorKernelPreference,
} from '../../../../src/document/editors/kernel-preference';
import type { AlterDoc, BlockNode } from '../../../../src/document/types';

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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown })
  .ResizeObserver;

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalResizeObserver;
});

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function sampleDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 7,
    blocks: [
      block('blk_h1', 'heading', { level: 1 }, {
        content: [{ type: 'text', text: '标题' }],
      }),
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '正文内容' }],
      }),
    ],
  };
}

function makeNode(doc: AlterDoc): SpaceNode {
  return {
    id: 'doc-1',
    spaceId: 'sp-1',
    kind: 'note',
    title: '测试文档',
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
    content: JSON.stringify(doc),
    activity: 100,
    activityAt: '2026-11-10T00:00:00.000Z',
    lastOpenCreditAt: null,
    lastEditCreditAt: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    order: 0,
  } as SpaceNode;
}

function renderPage(doc: AlterDoc) {
  const node = makeNode(doc);
  const client = {
    get: vi.fn(async () => ({
      docId: 'doc-1',
      revision: doc.revision,
      title: '测试文档',
      doc,
    })),
    applyOperations: vi.fn(async () => ({
      docId: 'doc-1',
      revision: doc.revision + 1,
    })),
    restoreVersion: vi.fn(async () => ({ revision: doc.revision + 1 })),
    importAsset: vi.fn(),
    importFile: vi.fn(),
  };
  const service = {
    listComments: vi.fn(async () => []),
    recordOpen: vi.fn(async () => node),
    saveNode: vi.fn(async () => node),
    getNode: vi.fn(async () => node),
    addComment: vi.fn(async () => ({})),
    updateComment: vi.fn(async () => ({})),
    resolveComment: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => undefined),
    addCommentSupplement: vi.fn(async () => ({})),
    listVersions: vi.fn(async () => []),
    createNode: vi.fn(async () => node),
    setArchived: vi.fn(async () => node),
    document: client,
  };
  const context = {
    service,
    router: { navigate: vi.fn() },
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间' },
    spaceId: 'sp-1',
    nodes: [node],
    thoughts: [],
    version: 0,
    refresh: vi.fn(),
    toast: vi.fn(),
    addNodeToState: vi.fn(),
    updateNodeInState: vi.fn(),
    openSearch: vi.fn(),
    openThoughtComposer: vi.fn(),
    openDirectory: vi.fn(),
    closeDirectory: vi.fn(),
    removeSpaceFromState: vi.fn(),
    addSpaceToState: vi.fn(),
    openWeb: vi.fn(),
    workbench: undefined,
  };
  const view = render(
    createElement(
      SpaceContext.Provider,
      { value: context as never },
      createElement(DocumentView, { node, embedded: true }),
    ),
  );
  return { ...view, client, context };
}

/** Live ProseMirror view the kernel exposes on its host element. */
function findProseMirrorView(
  surface: HTMLElement,
): { state: { doc: { content: { size: number } }; tr: unknown }; dispatch(tr: unknown): void } | undefined {
  const host = surface.closest('[data-editor-kernel="tiptap"]') as
    | (HTMLElement & { pmView?: never })
    | null;
  return host?.pmView as never;
}

describe('kernel preference wired into the document page', () => {
  it('renders the AST-native body by default', async () => {
    expect(DEFAULT_EDITOR_KERNEL).toBe('tiptap');
    const doc = sampleDoc();
    renderPage(doc);
    await waitFor(() => {
      expect(
        document.querySelector('[data-editor-kernel="tiptap"]'),
      ).not.toBeNull();
    });
    // The legacy contenteditable surface is not mounted by default.
    expect(
      document.querySelector('[role="textbox"][aria-label="文档正文"]'),
    ).toBeNull();
  });

  it('falls back to the legacy body when the preference asks for it', async () => {
    // The rollback path stays selectable until the legacy adapter is retired.
    writeEditorKernelPreference({ current: 'legacy' });
    const doc = sampleDoc();
    renderPage(doc);
    await waitFor(() => {
      expect(
        document.querySelector('[role="textbox"][aria-label="文档正文"]'),
      ).not.toBeNull();
    });
    expect(
      document.querySelector('[data-editor-kernel="tiptap"]'),
    ).toBeNull();
    expect(screen.getByText(/标题/)).toBeTruthy();
  });

  it('mounts the AST-native body when the preference selects it', async () => {
    writeEditorKernelPreference({ current: 'tiptap' });
    expect(readEditorKernelPreference().current).toBe('tiptap');
    const doc = sampleDoc();
    renderPage(doc);
    await waitFor(() => {
      expect(
        document.querySelector('[data-editor-kernel="tiptap"]'),
      ).not.toBeNull();
    });
    // The same document renders in the new kernel…
    const body = document.querySelector('[data-editor-kernel="tiptap"]');
    await waitFor(() => {
      expect(body?.textContent).toContain('标题');
      expect(body?.textContent).toContain('正文内容');
    });
    // …and the legacy contenteditable surface is not mounted.
    expect(
      document.querySelector('[role="textbox"][aria-label="文档正文"]'),
    ).toBeNull();
  });

  it('reports an AST edit from the AST-native body to the page', async () => {
    // Drive the kernel's own view (jsdom has no `execCommand`, so a simulated
    // keypress cannot produce a real edit); this proves the wiring from a
    // ProseMirror transaction to `onBlocks` and then to the save pipeline.
    writeEditorKernelPreference({ current: 'tiptap' });
    const doc = sampleDoc();
    const { client } = renderPage(doc);
    await waitFor(() => {
      expect(
        document.querySelector('[data-editor-kernel="tiptap"]'),
      ).not.toBeNull();
    });
    const surface = document.querySelector<HTMLElement>('.ProseMirror');
    expect(surface).not.toBeNull();

    const view = findProseMirrorView(surface as HTMLElement);
    expect(view).toBeDefined();
    await act(async () => {
      const end = view!.state.doc.content.size;
      view!.dispatch(view!.state.tr.insertText('新', end - 1));
    });

    // The page debounces saves (~700ms); wait for the cycle to land.
    await waitFor(
      () => {
        expect(client.applyOperations).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );

    // The page captured the edit as AST blocks and handed it to the save layer.
    const input = client.applyOperations.mock.calls.at(-1)?.[0] as
      | { ops: unknown[]; baseRevision: number }
      | undefined;
    expect(input).toBeDefined();
    expect(input!.baseRevision).toBe(doc.revision);
    expect(JSON.stringify(input!.ops)).toContain('新');
  });

  it('ignores a foreign stored kernel value and uses the default', async () => {
    localStorage.setItem(
      EDITOR_KERNEL_PREFERENCE_KEY,
      '{"current":"some-other-editor"}',
    );
    const doc = sampleDoc();
    renderPage(doc);
    await waitFor(() => {
      expect(
        document.querySelector('[data-editor-kernel="tiptap"]'),
      ).not.toBeNull();
    });
    // A value nobody recognises must not silently select the legacy body.
    expect(
      document.querySelector('[role="textbox"][aria-label="文档正文"]'),
    ).toBeNull();
  });
});

