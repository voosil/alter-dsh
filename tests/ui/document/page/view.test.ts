// @vitest-environment jsdom
/**
 * Document page data layer on the AST-native kernel.
 *
 * The frozen `DocumentView` keeps its original DOM/CSS; these tests verify the
 * page wiring: loading AST content into the body, autosaving through Document
 * Operations, failure UI, title persistence, external revision reload, version
 * restore and page-level asset upload.
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import { SAVE_DEBOUNCE_MS } from '../../../../src/document/runtime';
import type { AlterDoc } from '../../../../src/document/types';
import { SpaceContext } from '../../../../vendor/ui-space/src/runtime';
import { HistoryPanel } from '../../../../vendor/ui-space/src/components/HistoryPanel';
import {
  block,
  createPageClient,
  createPageContext,
  docOf,
  editorSurface,
  installResizeObserver,
  lastApplyInput,
  makeNode,
  mountDocumentPage,
  paragraph,
  replaceFirstBlockText,
  settle,
  tick,
} from '../../../support/document-page';

let restoreResizeObserver: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreResizeObserver();
});

function sampleDoc(revision = 7): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision,
    blocks: [
      block('blk_h1', 'heading', { level: 1 }, {
        content: [{ type: 'text', text: '鉴权方案' }],
      }),
      paragraph('blk_p', '编辑器正文'),
      block('blk_ul', 'bulletList', {}, {
        children: [
          block('blk_li', 'listItem', {}, {
            children: [paragraph('blk_lip', '列表项')],
          }),
        ],
      }),
    ],
  };
}

/** A document whose body is the given plain paragraph. */
function paragraphDoc(text: string, revision = 7): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision,
    blocks: [paragraph('blk_p', text)],
  };
}

async function settlePage(): Promise<void> {
  await settle();
}

describe('document page on the AST-native kernel', () => {
  it('loads the AST body into the frozen document page', async () => {
    const doc = sampleDoc();
    const page = mountDocumentPage(makeNode(doc), createPageClient(doc));
    await waitFor(() => {
      expect(screen.getByText('鉴权方案')).toBeTruthy();
      expect(screen.getByText('编辑器正文')).toBeTruthy();
      expect(screen.getByText('列表项')).toBeTruthy();
    });
    // The frozen shell DOM is unchanged: title textarea, editable region and
    // the block elements projected from the AST.
    const title = screen.getByLabelText('文档标题') as HTMLTextAreaElement;
    expect(title.tagName).toBe('TEXTAREA');
    expect(title.value).toBe('测试文档');
    expect(title.placeholder).toBe('无标题');
    const surface = editorSurface(page.container);
    expect(surface.getAttribute('contenteditable')).toBe('true');
    expect(surface.getAttribute('aria-multiline')).toBe('true');
    expect(surface.getAttribute('data-placeholder')).toBe('开始写点什么…');
    expect(surface.querySelector('[data-block-id="blk_h1"]')).not.toBeNull();
    expect(surface.querySelector('h1')?.textContent).toBe('鉴权方案');
    expect(surface.querySelector('li')?.textContent).toBe('列表项');
  });

  it('autosaves a body edit as Document Operations after the debounce', async () => {
    vi.useFakeTimers();
    const doc = paragraphDoc('原始正文');
    const client = createPageClient(doc, {
      applyOperations: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    const page = mountDocumentPage(makeNode(doc), client);
    await settlePage();
    expect(page.bodyText()).toContain('原始正文');

    const surface = page.surface();
    const view = page.view();
    await replaceFirstBlockText('改后的正文', page.container);

    await tick(SAVE_DEBOUNCE_MS - 10);
    expect(client.applyOperations).not.toHaveBeenCalled();
    await tick(20);
    await settlePage();
    expect(client.applyOperations).toHaveBeenCalledTimes(1);
    const input = lastApplyInput(client)!;
    expect(input.docId).toBe('doc-1');
    expect(input.baseRevision).toBe(7);
    expect(input.ops.length).toBeGreaterThan(0);
    expect(JSON.stringify(input.ops)).toContain('改后的正文');
    expect(page.refresh).toHaveBeenCalled();
    // A4: the save echo must not recreate the editing surface.
    expect(page.surface()).toBe(surface);
    expect(page.view()).toBe(view);
    expect(page.bodyText()).toContain('改后的正文');
  });

  it('shows the 保存失败，重试 action when a save fails', async () => {
    vi.useFakeTimers();
    const doc = paragraphDoc('原始正文');
    const client = createPageClient(doc, {
      applyOperations: async () => {
        throw new Error('网络不可用');
      },
    });
    const page = mountDocumentPage(makeNode(doc), client);
    await settlePage();
    await replaceFirstBlockText('失败保留的内容', page.container);
    await tick(SAVE_DEBOUNCE_MS);
    await settlePage();
    expect(screen.getByRole('button', { name: '保存失败，重试' })).toBeTruthy();
    // The edited content is still in the editor (no silent loss).
    expect(page.bodyText()).toContain('失败保留的内容');
  });

  it('persists the title through the metadata endpoint', async () => {
    vi.useFakeTimers();
    const doc = sampleDoc();
    const page = mountDocumentPage(makeNode(doc), createPageClient(doc));
    await settlePage();
    fireEvent.change(screen.getByLabelText('文档标题'), {
      target: { value: '新标题' },
    });
    await tick(SAVE_DEBOUNCE_MS);
    await settlePage();
    expect(page.service.saveNode).toHaveBeenCalledWith('doc-1', {
      title: '新标题',
    });
  });

  it('uploads a pasted image through the page asset channel before saving', async () => {
    const doc = paragraphDoc('原始正文');
    const importAsset = vi.fn(async () => ({
      assetId: 'asset_paste1',
      mime: 'image/png',
      bytes: 4,
    }));
    const client = createPageClient(doc, {
      importAsset,
      applyOperations: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => expect(page.surface()).toBeTruthy());

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', {
      type: 'image/png',
    });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [file], types: ['Files'], getData: () => '' },
    });
    page.surface().dispatchEvent(event);

    // The kernel uploads the payload on paste; the data URL never enters AST.
    await waitFor(() => expect(importAsset).toHaveBeenCalled(), {
      timeout: 3000,
    });
    await waitFor(() => expect(client.applyOperations).toHaveBeenCalled(), {
      timeout: 3000,
    });
    const surface = page.surface();
    const image = surface.querySelector('img[data-asset-id="asset_paste1"]');
    expect(image).not.toBeNull();
    expect(surface.querySelector('img[src^="data:"]')).toBeNull();
    const json = JSON.stringify(lastApplyInput(client)!.ops);
    expect(json).toContain('"type":"image"');
    expect(json).toContain('asset_paste1');
    expect(json).not.toContain('data:image');
  });

  it('shows the Host upload error through the page toast', async () => {
    const doc = paragraphDoc('原始正文');
    const hostMessage =
      '文件超过 8 MiB 上限（8388608 字节，上限 8388608 字节）';
    const importAsset = vi.fn(async () => {
      throw new Error(hostMessage);
    });
    const client = createPageClient(doc, { importAsset });
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => expect(page.surface()).toBeTruthy());

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'big.png', {
      type: 'image/png',
    });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [file], types: ['Files'], getData: () => '' },
    });
    page.surface().dispatchEvent(event);

    // The page forwards the Host message unchanged; the old generic wording
    // must never replace it.
    await waitFor(() => expect(page.toast).toHaveBeenCalledWith(hostMessage), {
      timeout: 3000,
    });
    expect(page.toast).not.toHaveBeenCalledWith('附件上传失败，请重试');
    expect(page.surface().querySelector('img[data-asset-id]')).toBeNull();
  });

  it('restores a version from the document menu through the client', async () => {
    const doc = sampleDoc();
    const version = {
      id: 'ver-1',
      docId: 'doc-1',
      title: '测试文档',
      content: JSON.stringify({
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 2,
        blocks: [paragraph('blk_old', '旧版本内容')],
      }),
      author: 'me',
      at: '2026-11-09T00:00:00.000Z',
    };
    const client = createPageClient(doc, {
      restoreVersion: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    mountDocumentPage(makeNode(doc), client, {
      listVersions: vi.fn(async () => [version]),
    });
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
    const historyItem = await screen.findByRole('menuitem', {
      name: /历史记录/,
    });
    fireEvent.click(historyItem);
    await waitFor(() => expect(screen.getByText('旧版本内容')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /还原到此版本/ }));
    await waitFor(() =>
      expect(client.restoreVersion).toHaveBeenCalledWith({
        docId: 'doc-1',
        versionId: 'ver-1',
        baseRevision: 7,
      }),
    );
  });

  it('reloads the body when an external snapshot changes the revision', async () => {
    const doc = sampleDoc();
    const client = createPageClient(doc);
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    const updated: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 8,
      blocks: [paragraph('blk_new', '外部新内容')],
    };
    const updatedNode = makeNode(updated, {
      updatedAt: '2026-11-10T01:00:00.000Z',
    });
    await act(async () => {
      page.rerenderPage(updatedNode);
    });
    await waitFor(() => {
      expect(screen.getByText('外部新内容')).toBeTruthy();
      expect(screen.queryByText('编辑器正文')).toBeNull();
    });
    // The explicit reload replaces the body (a new editing session), and the
    // next save writes the restored AST, not the pre-reload content.
    expect(
      page.surface().querySelector('[data-block-id="blk_new"]'),
    ).not.toBeNull();
    await page.insertAtEnd('（改）');
    await waitFor(
      () => expect(client.applyOperations).toHaveBeenCalled(),
      { timeout: 5000 },
    );
    const json = JSON.stringify(lastApplyInput(client)!.ops);
    expect(json).toContain('外部新内容');
    expect(json).not.toContain('编辑器正文');
  });

  it('exports Markdown from the live body, not the first-frame content', async () => {
    const doc = paragraphDoc('原始正文');
    const client = createPageClient(doc);
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => expect(page.surface()).toBeTruthy());
    await page.insertAtEnd('（导出时的新文本）');

    const createObjectURL = vi.fn(() => 'blob:markdown-export');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
      fireEvent.click(
        await screen.findByRole('menuitem', { name: /导出 Markdown/ }),
      );
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      const blob = createObjectURL.mock.calls[0]![0] as Blob;
      await expect(blob.text()).resolves.toContain('（导出时的新文本）');
    } finally {
      click.mockRestore();
    }
  });

  it('keeps the body non-empty after the save echo (content from blocks)', async () => {
    const doc = docOf([], 1);
    const client = createPageClient(doc, {
      applyOperations: async () => ({ docId: 'doc-1', revision: 2 }),
    });
    const page = mountDocumentPage(makeNode(doc, { title: '' }), client);
    await waitFor(() => expect(page.surface()).toBeTruthy());
    // An empty note hides the meta row and footer.
    expect(page.container.querySelector('header[data-empty]')).not.toBeNull();

    await page.insertAtEnd('新内容');
    await waitFor(() => expect(client.applyOperations).toHaveBeenCalled(), {
      timeout: 5000,
    });
    // The Host echo arrives at the revision the save just adopted: the page
    // adopts it without rebuilding the body, and the non-empty decision stays
    // derived from the captured blocks (not from the first-frame HTML).
    const echoDoc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 2,
      blocks: [paragraph('blk_p', '新内容')],
    };
    await act(async () => {
      page.rerenderPage(makeNode(echoDoc, { title: '' }));
    });
    await waitFor(() => {
      expect(page.container.querySelector('header[data-empty]')).toBeNull();
      expect(
        page.container.querySelector('section[aria-label="文档附加内容"]'),
      ).not.toBeNull();
    });
    expect(page.bodyText()).toContain('新内容');
  });
});

describe('HistoryPanel version preview and restore', () => {
  function versionFixture() {
    return {
      id: 'ver-1',
      docId: 'doc-1',
      title: '测试文档',
      content: JSON.stringify({
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 2,
        blocks: [paragraph('blk_old', '旧版本内容')],
      }),
      author: 'me',
      at: '2026-11-09T00:00:00.000Z',
    };
  }

  it('never opens the comment composer just because text is selected', async () => {
    // Regression: after posting a comment, every later selection used to set a
    // pending quote and pop the rail's composer open.
    const doc = paragraphDoc('可以评论的正文');
    const client = createPageClient(doc);
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => expect(page.surface()).toBeTruthy());

    const view = page.view();
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1),
      ),
    );
    await settle();

    expect(screen.queryByLabelText('评论内容')).toBeNull();
    const rail = document.querySelector('[aria-label="评论"]');
    expect(rail?.getAttribute('data-open')).toBeNull();
  });

  it('renders AST version bodies as frozen HTML and restores through the client', async () => {
    const doc = sampleDoc();
    const client = createPageClient(doc, {
      restoreVersion: async () => ({ docId: 'doc-1', revision: 8 }),
    });
    const node = makeNode(doc);
    const context = createPageContext(node, client, {
      listVersions: vi.fn(async () => [versionFixture()]),
    });
    const onRestored = vi.fn();
    render(
      createElement(
        SpaceContext.Provider,
        { value: context.value as never },
        createElement(HistoryPanel, {
          open: true,
          doc: node,
          baseRevision: 7,
          onClose: vi.fn(),
          onRestored,
        } as never),
      ),
    );
    await waitFor(() => {
      expect(screen.getByText('旧版本内容')).toBeTruthy();
    });
    // AST JSON must never be rendered as raw text in the preview.
    expect(document.body.textContent).not.toContain('"format":"alter-doc/1"');
    fireEvent.click(screen.getByRole('button', { name: /还原到此版本/ }));
    await waitFor(() => {
      expect(client.restoreVersion).toHaveBeenCalledWith({
        docId: 'doc-1',
        versionId: 'ver-1',
        baseRevision: 7,
      });
    });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
