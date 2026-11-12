// @vitest-environment jsdom
/**
 * History panel + soft-deleted comments on the document page.
 *
 * Deleting a comment keeps it as a tombstone (`status: 'deleted'`): it leaves
 * the rail and the 全文评论 list, and shows up in 历史评论 next to resolved
 * (采纳) comments on one newest-first timeline. A body save re-reads the list
 * because deleting commented text cascades deletes on the Host.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment } from '../../../../vendor/protocol/src/space';
import { HistoryCommentsModal } from '../../../../vendor/ui-space/src/components/HistoryCommentsModal';
import type { AlterDoc } from '../../../../src/document/types';
import {
  createPageClient,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
  settle,
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

function sampleDoc(revision = 3): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision,
    blocks: [paragraph('blk_p', '被评论的正文')],
  };
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c-1',
    docId: 'doc-1',
    author: 'me',
    body: '一条评论',
    quote: '被评论的正文',
    anchor: { blockId: 'blk_p', offset: 0, length: 5 },
    status: 'open',
    createdAt: '2026-11-01T00:00:00.000Z',
    resolvedAt: null,
    deletedAt: null,
    editedAt: null,
    supplements: [],
    ...overrides,
  };
}

/** Open the document menu and pick one action by its accessible label. */
async function openMenuAction(label: string): Promise<void> {
  fireEvent.click(screen.getByLabelText('文档菜单'));
  const item = await screen.findByRole('menuitem', { name: label });
  fireEvent.click(item);
}

/** Click the 删除 confirm step inside one comment card. */
async function confirmDelete(card: HTMLElement): Promise<void> {
  fireEvent.click(within(card).getByLabelText('更多评论操作'));
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
  // Two steps share the label 「删除」: the menu item and the confirm button.
  await waitFor(() => expect(card.textContent).toContain('删除？'));
  const confirm = Array.from(card.querySelectorAll('button')).find(
    (button) => button.textContent === '删除',
  );
  if (!confirm) throw new Error('delete confirmation button is missing');
  fireEvent.click(confirm);
}

describe('deleting a comment', () => {
  it('leaves the rail and shows up in 历史评论 as 已删除', async () => {
    const doc = sampleDoc();
    const client = createPageClient(doc);
    const openComment = comment({ id: 'c-open', body: '我会被删除' });
    const listComments = vi.fn(async () => [openComment]);
    const deleteComment = vi.fn(async () => undefined);
    const page = mountDocumentPage(makeNode(doc), client, {
      listComments,
      deleteComment,
    });
    await settle();

    // The open comment sits on the rail.
    const rail = await screen.findByLabelText('评论');
    const card = await within(rail).findByText('我会被删除');
    expect(card).toBeTruthy();

    await confirmDelete(card.closest('article') as HTMLElement);
    await settle();

    // (a) the rail no longer shows it, Host rejected nothing.
    expect(deleteComment).toHaveBeenCalledWith('c-open');
    await waitFor(() =>
      expect(within(rail).queryByText('我会被删除')).toBeNull(),
    );
    expect(page.toast).toHaveBeenCalledWith('评论已删除');
    expect(screen.queryByRole('dialog')).toBeNull();

    // (b) the history menu entry is enabled and shows the tombstone.
    await openMenuAction('历史评论');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('我会被删除')).toBeTruthy();
    expect(within(dialog).getByText(/已删除$/)).toBeTruthy();
  });
});

describe('历史评论 modal', () => {
  it('merges resolved and deleted comments newest first', async () => {
    const comments = [
      comment({
        id: 'c-open',
        body: '还没处理的评论',
        createdAt: '2026-11-05T00:00:00.000Z',
      }),
      comment({
        id: 'c-resolved-old',
        body: '早早被采纳的评论',
        status: 'resolved',
        resolvedAt: '2026-11-02T00:00:00.000Z',
      }),
      comment({
        id: 'c-deleted-new',
        body: '刚刚被删除的评论',
        status: 'deleted',
        deletedAt: '2026-11-04T00:00:00.000Z',
      }),
    ];
    render(
      createElement(HistoryCommentsModal, {
        open: true,
        comments,
        onClose: () => undefined,
      }),
    );
    const dialog = await screen.findByRole('dialog');

    // (c) resolved reads 采纳, deleted reads 已删除.
    expect(within(dialog).getByText(/采纳$/)).toBeTruthy();
    expect(within(dialog).getByText(/已删除$/)).toBeTruthy();
    // Open comments never enter the history panel.
    expect(within(dialog).queryByText('还没处理的评论')).toBeNull();

    // (d) newest-first by deletedAt / resolvedAt.
    const bodies = Array.from(
      dialog.querySelectorAll('article'),
    ).map((article) => article.lastElementChild?.textContent);
    expect(bodies).toEqual(['刚刚被删除的评论', '早早被采纳的评论']);
  });

  it('explains both kinds in the empty state', async () => {
    render(
      createElement(HistoryCommentsModal, {
        open: true,
        comments: [comment()],
        onClose: () => undefined,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('还没有历史评论')).toBeTruthy();
    expect(
      within(dialog).getByText('评论被采纳或删除后会保存在这里。'),
    ).toBeTruthy();
  });
});

describe('body saves', () => {
  it('re-reads the comment list so cascaded deletes disappear', async () => {
    vi.useFakeTimers();
    const doc = sampleDoc();
    const client = createPageClient(doc);
    const inline = comment({ id: 'c-inline', body: '会被级联删除的评论' });
    const listComments = vi.fn(async () => [inline]);
    const page = mountDocumentPage(makeNode(doc), client, { listComments });
    await settle();
    expect(listComments).toHaveBeenCalledTimes(1);

    // Deleting the commented text cascades the comment on the Host: the next
    // list read (after the save lands) returns the tombstone only.
    listComments.mockImplementation(async () => [
      { ...inline, status: 'deleted', deletedAt: '2026-11-06T00:00:00.000Z' },
    ]);
    await page.replaceFirstBlockText('改写后的正文');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    console.log('SAVE', client.applyOperations.mock.calls.length, 'LIST', listComments.mock.calls.length);
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    console.log('SAVE2', client.applyOperations.mock.calls.length, 'LIST', listComments.mock.calls.length);

    expect(client.applyOperations).toHaveBeenCalled();
    expect(listComments).toHaveBeenCalledTimes(2);
    // The remembered quote is not written back: the Host no longer has it open.
    const quoteWrites = (
      page.service.updateComment as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => 'quote' in ((call[1] ?? {}) as object));
    expect(quoteWrites).toEqual([]);
    const rail = screen.getByLabelText('评论');
    await waitFor(() =>
      expect(within(rail).queryByText('会被级联删除的评论')).toBeNull(),
    );
  });
});