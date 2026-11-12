// @vitest-environment jsdom
/**
 * E1/E2 resilience: the document page never white-screens, corrupted content
 * becomes an explicit error state, render crashes are caught by the boundary,
 * and every failure leaves a structured (content-free) diagnostic trace.
 */
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_ERROR_LOG_PREFIX,
  reportDocumentError,
} from '../../../../src/document/runtime';
import { SpaceRemoteError } from '../../../../src/client/rpc';
import type { AlterDoc } from '../../../../src/document/types';
import { DocumentErrorBoundary } from '../../../../vendor/ui-space/src/components/DocumentErrorBoundary';
import { overviewPath } from '../../../../vendor/ui-space/src/space-route';
import {
  block,
  createPageClient,
  editorSurface,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
  settle,
  tick,
} from '../../../support/document-page';

let restoreResizeObserver: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
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
    ],
  };
}

function reportsFrom(
  spy: ReturnType<typeof vi.spyOn>,
): Array<Record<string, unknown>> {
  return (spy.mock.calls as unknown[][])
    .filter((call) => call[0] === DOCUMENT_ERROR_LOG_PREFIX)
    .map((call) => call[1] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// E2: structured diagnostics
// ---------------------------------------------------------------------------

describe('document error reporting (E2)', () => {
  it('reports structured identifiers and never logs document content', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('保存失败'), {
      code: 'doc/conflict',
    });
    const report = reportDocumentError('save', error, {
      docId: 'doc-1',
      revision: 4,
      content: '机密正文不应出现在日志里',
    });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]![0]).toBe(DOCUMENT_ERROR_LOG_PREFIX);
    expect(report).toMatchObject({
      scope: 'save',
      code: 'doc/conflict',
      message: '保存失败',
      docId: 'doc-1',
      revision: 4,
    });
    expect(JSON.stringify(report)).not.toContain('机密正文');
    expect(report).not.toHaveProperty('content');
  });
});

// ---------------------------------------------------------------------------
// E1: error boundary
// ---------------------------------------------------------------------------

describe('document error boundary (E1)', () => {
  it('catches a render crash, reports it and recovers through 重试', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goOverview = vi.fn();
    let crashed = true;
    function Child(): ReactNode {
      if (crashed) throw new Error('评论轨渲染失败');
      return createElement('p', null, '已恢复的正文');
    }
    render(
      createElement(
        DocumentErrorBoundary,
        {
          docId: 'doc-1',
          title: '文档界面出现异常',
          message: '可重试或返回空间目录',
          onGoOverview: goOverview,
          classNames: {
            scroller: 'scroller',
            paper: 'paper',
            header: 'header',
            title: 'title',
            body: 'body',
            actions: 'actions',
          },
        },
        createElement(Child),
      ),
    );
    expect(screen.getByText('文档界面出现异常')).toBeTruthy();
    expect(screen.getByText('可重试或返回空间目录')).toBeTruthy();
    const reports = reportsFrom(consoleSpy);
    expect(
      reports.some(
        (report) => report['scope'] === 'render' && report['docId'] === 'doc-1',
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '返回空间目录' }));
    expect(goOverview).toHaveBeenCalledTimes(1);

    crashed = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByText('已恢复的正文')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// E1: corrupted content is an explicit error page (not a blank document)
// ---------------------------------------------------------------------------

describe('document load failures (E1)', () => {
  it('shows an explicit error state for corrupted content and can navigate back', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const node = makeNode(doc, { content: '{not-json' });
    const page = mountDocumentPage(node, createPageClient(doc));
    await waitFor(() => expect(screen.getByText('无法显示文档')).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    const reports = reportsFrom(consoleSpy);
    expect(
      reports.some(
        (report) => report['scope'] === 'load' && report['docId'] === 'doc-1',
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '返回空间目录' }));
    expect(page.router.navigate).toHaveBeenCalledWith(overviewPath('sp-1'));
  });

  it('recovers from a corrupt stored snapshot through a Host reload', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const node = makeNode(doc, { content: '{broken' });
    const client = createPageClient(doc);
    const page = mountDocumentPage(node, client);
    await waitFor(() => expect(screen.getByText('无法显示文档')).toBeTruthy());
    expect(client.get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(editorSurface(page.container)).toBeTruthy();
    expect(
      reportsFrom(consoleSpy).some((report) => report['scope'] === 'load'),
    ).toBe(true);
  });

  it('keeps the page usable when comments fail to load (no crash)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const page = mountDocumentPage(makeNode(doc), createPageClient(doc), {
      listComments: async () => {
        throw new Error('评论接口 500');
      },
    });
    await waitFor(() => expect(screen.getByText('编辑器正文')).toBeTruthy());
    await waitFor(() =>
      expect(
        reportsFrom(consoleSpy).some(
          (report) => report['scope'] === 'comments',
        ),
      ).toBe(true),
    );
    expect(page.toast).toHaveBeenCalledWith('评论加载失败，请稍后重试');
    // The editor is still there and editable.
    expect(
      editorSurface(page.container).getAttribute('contenteditable'),
    ).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// E2: save failures keep the retry button and add an export-draft escape
// ---------------------------------------------------------------------------

describe('document save failure actions (E2)', () => {
  it('shows 导出草稿 next to 保存失败，重试 and downloads the draft', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const client = createPageClient(doc, {
      applyOperations: async () => {
        throw new Error('网络不可用');
      },
    });
    const page = mountDocumentPage(makeNode(doc), client);
    await settle();
    await page.replaceFirstBlockText('失败但仍保留的正文');
    await tick(700);
    await settle();

    expect(screen.getByRole('button', { name: '保存失败，重试' })).toBeTruthy();
    const exportButton = screen.getByRole('button', { name: '导出草稿' });
    expect(exportButton).toBeTruthy();
    expect(
      reportsFrom(consoleSpy).some((report) => report['scope'] === 'save'),
    ).toBe(true);

    const originalCreate = (
      URL as unknown as { createObjectURL?: unknown }
    ).createObjectURL;
    const originalRevoke = (
      URL as unknown as { revokeObjectURL?: unknown }
    ).revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:mock-draft');
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL =
      createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL =
      revokeObjectURL;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      fireEvent.click(exportButton);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
      (URL as unknown as Record<string, unknown>).createObjectURL =
        originalCreate;
      (URL as unknown as Record<string, unknown>).revokeObjectURL =
        originalRevoke;
    }
    // The failed edit is still in the editor; no toast was needed.
    expect(page.bodyText()).toContain('失败但仍保留的正文');
    expect(page.toast).not.toHaveBeenCalledWith('部分评论锚点已失效');
  });

  it('keeps the conflict dialog as the only export path for conflicts', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = sampleDoc();
    const serverDoc = sampleDoc(9);
    const client = createPageClient(doc, {
      applyOperations: async () => {
        throw new SpaceRemoteError('doc/conflict', '文档已被修改');
      },
      get: async () => ({
        docId: 'doc-1',
        revision: 9,
        title: '测试文档',
        doc: serverDoc,
      }),
    });
    const page = mountDocumentPage(makeNode(doc), client);
    await settle();
    await page.replaceFirstBlockText('冲突时保留的正文');
    await tick(700);
    await settle();
    await settle();

    expect(screen.getByText('文档已被其他修改')).toBeTruthy();
    // Conflict keeps its own dialog actions; the header must not grow a second
    // export button (appearance freeze: no extra normal-state controls).
    // The modal hides the background from the a11y tree, so query text here.
    expect(screen.getAllByText('导出草稿')).toHaveLength(1);
    expect(screen.getByText('保存失败，重试')).toBeTruthy();
  });
});