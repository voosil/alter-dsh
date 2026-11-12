// @vitest-environment jsdom
/**
 * Document page end-to-end on the AST-native kernel.
 *
 * The retired contentEditable kernel is gone: the page always mounts the Tiptap
 * kernel, loads the same document, reports edits as canonical AST blocks into
 * the 700ms save pipeline, adopts explicit external reloads, and keeps the
 * frozen toolbar's 文本类型 menu wired.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlterDoc } from '../../../../src/document/types';
import {
  block,
  createPageClient,
  installResizeObserver,
  lastApplyInput,
  makeNode,
  mountDocumentPage,
  paragraph,
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

function sampleDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 7,
    blocks: [
      block('blk_h1', 'heading', { level: 1 }, {
        content: [{ type: 'text', text: '标题' }],
      }),
      paragraph('blk_p', '正文内容'),
    ],
  };
}

function paragraphDoc(revision = 7): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision,
    blocks: [paragraph('blk_p', '正文内容')],
  };
}

describe('document page', () => {
  it('mounts only the AST-native kernel and loads the document', async () => {
    const doc = sampleDoc();
    mountDocumentPage(makeNode(doc), createPageClient(doc));
    await waitFor(() => {
      expect(
        document.querySelector('[data-editor-kernel="tiptap"]'),
      ).not.toBeNull();
    });
    // The retired contentEditable kernel is not mounted any more.
    expect(
      document.querySelector('[data-editor-kernel="legacy"]'),
    ).toBeNull();
    const body = document.querySelector('[data-editor-kernel="tiptap"]');
    await waitFor(() => {
      expect(body?.textContent).toContain('标题');
      expect(body?.textContent).toContain('正文内容');
    });
    expect(screen.getByLabelText('文档标题')).toBeTruthy();
  });

  it('reports a body edit to the 700ms save pipeline as AST operations', async () => {
    const doc = sampleDoc();
    const client = createPageClient(doc);
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => {
      expect(page.surface()).toBeTruthy();
    });
    await page.insertAtEnd('（新）');

    // The page debounces saves (~700ms); wait for the cycle to land.
    await waitFor(
      () => {
        expect(client.applyOperations).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
    const input = lastApplyInput(client)!;
    expect(input.baseRevision).toBe(doc.revision);
    expect(JSON.stringify(input.ops)).toContain('（新）');
  });

  it('reloads the body when the page adopts an external revision', async () => {
    const doc = sampleDoc();
    const client = createPageClient(doc);
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => {
      expect(screen.getByText('正文内容')).toBeTruthy();
    });

    const external: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 8,
      blocks: [paragraph('blk_restored', '恢复后的内容')],
    };
    await act(async () => {
      page.rerenderPage(makeNode(external, { title: '测试文档' }));
    });
    await waitFor(() => {
      expect(screen.getByText('恢复后的内容')).toBeTruthy();
    });
    expect(screen.queryByText('正文内容')).toBeNull();
  });

  it('opens the frozen 文本类型 menu from the toolbar and converts the block', async () => {
    // The menu is a page-owned frozen component: the kernel reports the anchor
    // and applies the choice. Without this wiring the toolbar button would be
    // inert.
    const doc = paragraphDoc();
    const client = createPageClient(doc);
    const page = mountDocumentPage(makeNode(doc), client);
    await waitFor(() => {
      expect(page.surface()).toBeTruthy();
    });
    const view = page.view();
    // Select the paragraph text so the floating toolbar appears.
    await act(async () => {
      const { TextSelection } = await import('@tiptap/pm/state');
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc as never, 1, 5),
        ),
      );
    });
    await waitFor(
      () =>
        expect(document.querySelector('[aria-label="文本类型"]')).not.toBeNull(),
      { timeout: 3000 },
    );
    const button = document.querySelector<HTMLElement>(
      '[aria-label="文本类型"]',
    )!;
    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(document.body.textContent).toContain('标题 1'));
    const heading = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === '标题 1',
    );
    expect(heading).toBeDefined();
    // Radix menu items select on the keyboard event, not a synthetic click.
    await act(async () => {
      heading!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await waitFor(() => {
      expect(
        document.querySelector('[data-editor-kernel="tiptap"] h1'),
      ).not.toBeNull();
    });
    // The conversion is a document edit: it reaches the save pipeline as AST.
    await waitFor(
      () => {
        expect(client.applyOperations).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
    const json = JSON.stringify(lastApplyInput(client)!.ops);
    expect(json).toContain('"type":"heading"');
    expect(json).toContain('"level":1');
  });
});