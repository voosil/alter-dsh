// @vitest-environment jsdom
/**
 * Document footer 「子文档」: creating a sub-document from the open page.
 *
 * The footer button is fire-and-forget (`void createChild()`), so the page must
 * both create the note under the open document and open it, and — when the
 * Host rejects the call — say so instead of looking like a dead button.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceRemoteError } from '../../../../src/client/rpc';
import { DOCUMENT_ERROR_LOG_PREFIX } from '../../../../src/document/runtime';
import type { AlterDoc } from '../../../../src/document/types';
import {
  createPageClient,
  docOf,
  installResizeObserver,
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
  vi.restoreAllMocks();
  restoreResizeObserver();
});

/** The open document: a plain paragraph so the footer (and its child tab) shows. */
function parentDoc(): AlterDoc {
  return docOf([paragraph('blk_p', '父文档正文')], 3);
}

function createReports(
  spy: ReturnType<typeof vi.spyOn>,
): Array<Record<string, unknown>> {
  return (spy.mock.calls as unknown[][])
    .filter((call) => call[0] === DOCUMENT_ERROR_LOG_PREFIX)
    .map((call) => call[1] as Record<string, unknown>);
}

describe('document footer 子文档', () => {
  it('creates a sub-document under the open note and opens it', async () => {
    const doc = parentDoc();
    const child = makeNode(docOf([]), {
      id: 'doc-child',
      parentId: 'doc-1',
      title: '',
    });
    const page = mountDocumentPage(makeNode(doc), createPageClient(doc), {
      createNode: vi.fn(async () => child),
    });
    await waitFor(() => expect(screen.getByText('父文档正文')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '新建子文档' }));

    await waitFor(() =>
      expect(page.service.createNode).toHaveBeenCalledWith({
        spaceId: 'sp-1',
        parentId: 'doc-1',
        kind: 'note',
      }),
    );
    await waitFor(() =>
      expect(page.router.navigate).toHaveBeenCalledWith(
        '#/space/sp-1/doc/doc-child',
      ),
    );
    expect(page.refresh).toHaveBeenCalled();
    expect(page.value.addNodeToState).toHaveBeenCalledWith(child);
  });

  it('surfaces a rejected creation instead of silently doing nothing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const doc = parentDoc();
    const page = mountDocumentPage(makeNode(doc), createPageClient(doc), {
      createNode: vi.fn(async () => {
        throw new SpaceRemoteError(
          'op/invalid',
          '父节点不存在或不属于当前空间',
        );
      }),
    });
    await waitFor(() => expect(screen.getByText('父文档正文')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '新建子文档' }));

    await waitFor(() =>
      expect(page.toast).toHaveBeenCalledWith('父节点不存在或不属于当前空间'),
    );
    expect(page.router.navigate).not.toHaveBeenCalled();
    expect(page.value.addNodeToState).not.toHaveBeenCalled();
    const reports = createReports(consoleSpy);
    expect(reports.some((report) => report.scope === 'create')).toBe(true);
  });
});
