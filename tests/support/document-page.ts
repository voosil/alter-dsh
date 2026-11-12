/**
 * jsdom harness for page-level document tests.
 *
 * The document page mounts the real `DocumentView` (frozen shell) over a mock
 * service and document client. jsdom cannot type into a `contenteditable`, so
 * editing goes through the mounted ProseMirror view (`pmView` on the kernel
 * host); assertions stay on `data-*`, ARIA, visible text and the ProseMirror
 * document — never on frozen CSS class names or editor-internal HTML.
 *
 * Tests import this module directly (not through `tests/support/index.ts`):
 * the module installs jsdom layout stubs at load time and must stay out of
 * node-environment suites.
 */
import { createElement } from 'react';
import { act, render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { SpaceNode } from '@alter/protocol';
import { SpaceContext } from '../../vendor/ui-space/src/runtime';
import { DocumentView } from '../../vendor/ui-space/src/views/DocumentView';
import type { AlterDoc, BlockNode } from '../../src/document/types';

// jsdom has no layout engine, but the frozen page and its floating surfaces
// measure element and range rectangles while mounting.
const zeroRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect;
const zeroRects = () => [] as unknown as DOMRectList;

if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.getClientRects !== 'function') {
    Element.prototype.getClientRects = zeroRects as never;
  }
}
if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = zeroRects as never;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = zeroRect as never;
  }
}
// jsdom has no hit testing; ProseMirror's paste/drop paths fall back to the
// caret when `elementFromPoint` is unavailable.
if (
  typeof document !== 'undefined' &&
  typeof document.elementFromPoint !== 'function'
) {
  (document as unknown as { elementFromPoint: () => null }).elementFromPoint =
    () => null;
}

/** No-op `ResizeObserver` for jsdom. */
export class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Install the `ResizeObserver` stub for one test.
 * @returns restore function (call from `afterEach`).
 */
export function installResizeObserver(): () => void {
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
  return () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  };
}

/** One block node with a stable id. */
export function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

/** One paragraph block. */
export function paragraph(id: string, text: string): BlockNode {
  return {
    id,
    type: 'paragraph',
    attrs: {},
    content: text === '' ? [] : [{ type: 'text', text }],
  };
}

/** A minimal `alter-doc/1` envelope. */
export function docOf(blocks: BlockNode[], revision = 1): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision, blocks };
}

/** Wrap a document as the `SpaceNode` the page receives from the tree. */
export function makeNode(
  doc: AlterDoc,
  overrides: Record<string, unknown> = {},
): SpaceNode {
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
    ...overrides,
  } as SpaceNode;
}

/** Structural document client the page consumes; all members are spies. */
export interface PageClient {
  get: ReturnType<typeof vi.fn>;
  applyOperations: ReturnType<typeof vi.fn>;
  restoreVersion: ReturnType<typeof vi.fn>;
  importAsset: ReturnType<typeof vi.fn>;
  importFile: ReturnType<typeof vi.fn>;
}

export interface PageClientOptions {
  get?: (docId: string) => Promise<unknown>;
  applyOperations?: (input: unknown) => Promise<unknown>;
  restoreVersion?: (input: unknown) => Promise<unknown>;
  importAsset?: (input: unknown) => Promise<unknown>;
  importFile?: (input: unknown) => Promise<unknown>;
}

/**
 * Build the document client double the page talks to.
 * @param doc - document the default `get` returns.
 * @param options - per-test overrides (all other calls succeed).
 */
export function createPageClient(
  doc: AlterDoc,
  options: PageClientOptions = {},
): PageClient {
  return {
    get: vi.fn(
      options.get ??
        (async () => ({
          docId: 'doc-1',
          revision: doc.revision,
          title: '测试文档',
          doc,
        })),
    ),
    applyOperations: vi.fn(
      options.applyOperations ??
        (async () => ({ docId: 'doc-1', revision: doc.revision + 1 })),
    ),
    restoreVersion: vi.fn(
      options.restoreVersion ??
        (async () => ({ docId: 'doc-1', revision: doc.revision + 1 })),
    ),
    importAsset: vi.fn(
      options.importAsset ??
        (async () => ({ assetId: 'asset_1', mime: 'image/png', bytes: 4 })),
    ),
    importFile: vi.fn(
      options.importFile ??
        (async () => ({
          assetId: 'asset_1',
          mime: 'application/pdf',
          bytes: 4,
          name: 'file.pdf',
        })),
    ),
  };
}

/** The service + context value the frozen page reads from `SpaceContext`. */
export interface PageContext {
  value: Record<string, unknown>;
  service: Record<string, unknown>;
  router: { navigate: ReturnType<typeof vi.fn> };
  refresh: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
}

/**
 * Compose the minimal page context over a document client.
 * @param node - document node the page renders.
 * @param client - document client double.
 * @param serviceOverrides - per-test service members (e.g. failing comments).
 */
export function createPageContext(
  node: SpaceNode,
  client: PageClient,
  serviceOverrides: Record<string, unknown> = {},
): PageContext {
  const service: Record<string, unknown> = {
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
    ...serviceOverrides,
  };
  const router = { navigate: vi.fn() };
  const refresh = vi.fn();
  const toast = vi.fn();
  const value = {
    service,
    router,
    spaces: [],
    agents: [],
    space: { id: 'sp-1', name: '空间' },
    spaceId: 'sp-1',
    nodes: [node],
    thoughts: [],
    version: 0,
    refresh,
    toast,
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
  return { value, service, router, refresh, toast };
}

/** The live ProseMirror view the page exposes on its kernel host. */
export interface PageView {
  state: {
    doc: {
      content: { size: number };
      child(index: number): { textContent: string };
      textBetween(from: number, to: number, blockSeparator?: string): string;
    };
    tr: {
      insertText(text: string, from?: number, to?: number): unknown;
      setSelection(selection: unknown): unknown;
    };
  };
  dispatch(tr: unknown): void;
}

/** The editable body element (`role=textbox`, frozen aria-label). */
export function editorSurface(scope: ParentNode = document): HTMLElement {
  const surface = scope.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="文档正文"]',
  );
  if (surface === null) throw new Error('editor surface is missing');
  return surface;
}

/** The kernel host element that owns the ProseMirror view. */
export function kernelHost(scope: ParentNode = document): HTMLElement {
  const host = scope.querySelector<HTMLElement>('[data-editor-kernel="tiptap"]');
  if (host === null) throw new Error('tiptap kernel host is missing');
  return host;
}

/** Read the mounted ProseMirror view off the kernel host. */
export function pageView(scope: ParentNode = document): PageView {
  const view = (kernelHost(scope) as HTMLElement & { pmView?: PageView })
    .pmView;
  if (view === undefined) throw new Error('ProseMirror view is missing');
  return view;
}

/** Flush React effects and the microtasks the page schedules after a render. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance fake timers inside `act` (pair with `vi.useFakeTimers()`). */
export async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Wait `ms` of real time inside `act` (pair with real timers). */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Insert text at the end of the body through a ProseMirror transaction. */
export async function insertAtEnd(
  text: string,
  scope: ParentNode = document,
): Promise<void> {
  await act(async () => {
    const view = pageView(scope);
    view.dispatch(
      view.state.tr.insertText(text, view.state.doc.content.size - 1),
    );
  });
}

/**
 * Replace the text of the first top-level block.
 *
 * Test documents place a plain paragraph first; ProseMirror text positions
 * inside that block run from `1` to `1 + text.length`.
 */
export async function replaceFirstBlockText(
  text: string,
  scope: ParentNode = document,
): Promise<void> {
  await act(async () => {
    const view = pageView(scope);
    const current = view.state.doc.child(0).textContent;
    view.dispatch(view.state.tr.insertText(text, 1, 1 + current.length));
  });
}

/** Visible text of the editable body. */
export function bodyText(scope: ParentNode = document): string {
  return editorSurface(scope).textContent ?? '';
}

/** Input of the last `applyOperations` call. */
export function lastApplyInput(
  client: PageClient,
):
  | {
      docId: string;
      baseRevision: number;
      ops: unknown[];
      idempotencyKey?: string;
    }
  | undefined {
  return client.applyOperations.mock.calls.at(-1)?.[0] as
    | {
        docId: string;
        baseRevision: number;
        ops: unknown[];
        idempotencyKey?: string;
      }
    | undefined;
}

/** A mounted document page plus its scoped editing helpers. */
export interface MountedPage extends PageContext {
  container: HTMLElement;
  client: PageClient;
  surface(): HTMLElement;
  kernelHost(): HTMLElement;
  view(): PageView;
  insertAtEnd(text: string): Promise<void>;
  replaceFirstBlockText(text: string): Promise<void>;
  bodyText(): string;
  rerenderPage(nextNode: SpaceNode): PageContext;
}

/**
 * Mount the frozen document page over a context.
 * @param node - document node to render.
 * @param client - document client double.
 * @param serviceOverrides - per-test service members.
 */
export function mountDocumentPage(
  node: SpaceNode,
  client: PageClient,
  serviceOverrides: Record<string, unknown> = {},
): MountedPage {
  const context = createPageContext(node, client, serviceOverrides);
  const result: RenderResult = render(
    createElement(
      SpaceContext.Provider,
      { value: context.value as never },
      createElement(DocumentView, { node } as never),
    ),
  );
  return {
    ...context,
    container: result.container,
    client,
    surface: () => editorSurface(result.container),
    kernelHost: () => kernelHost(result.container),
    view: () => pageView(result.container),
    insertAtEnd: (text) => insertAtEnd(text, result.container),
    replaceFirstBlockText: (text) =>
      replaceFirstBlockText(text, result.container),
    bodyText: () => bodyText(result.container),
    rerenderPage(nextNode: SpaceNode) {
      // Keep the same service/context identity: the page disposes its save
      // controller when the service identity changes (unmount semantics).
      //
      // The context's document list carries the stored content (what a real
      // refresh would return), so a rerender must update it too; a stale entry
      // makes the page see its own save echo as an external load.
      const value = {
        ...context.value,
        nodes: [nextNode],
      };
      result.rerender(
        createElement(
          SpaceContext.Provider,
          { value: value as never },
          createElement(DocumentView, { node: nextNode } as never),
        ),
      );
      return { ...context, value };
    },
  };
}