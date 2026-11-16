// @vitest-environment jsdom
/**
 * Document page: body column width dragging.
 *
 * The width preference is a browser-only reading preference (localStorage,
 * `alter.space.docWidth`); the page writes it back as an inline
 * `--alter-doc-width` variable and the handle only exists on a desktop page.
 *
 * jsdom has no layout: `getBoundingClientRect().width` is 0, so
 * `measureDocWidth` reports `UNMEASURED` — the handle still renders, the drag
 * starts from the 760px token fallback with a 1120px upper bound, and pointer
 * displacement scales by 2 (the centered column grows on both sides).
 * Assertions stay on ARIA, the inline CSS variable and localStorage; never on
 * CSS-module class names.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlterDoc } from '../../../../src/document/types';
import {
  DEFAULT_DOC_WIDTH,
  DOC_WIDTH_KEY,
  MAX_DOC_WIDTH,
  MIN_DOC_WIDTH,
} from '../../../../vendor/ui-space/src/utils/useDocWidth';
import {
  createPageClient,
  docOf,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
  settle,
  type DocumentPageOptions,
  type MountedPage,
} from '../../../support/document-page';

/** Accessible name the handle advertises to assistive tech. */
const HANDLE_LABEL = '调整正文宽度';

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
  return docOf([paragraph('blk_p', '正文')]);
}

function mountPage(options: DocumentPageOptions = {}): MountedPage {
  const doc = sampleDoc();
  return mountDocumentPage(
    makeNode(doc),
    createPageClient(doc),
    {},
    options,
  );
}

/** The page-level `<section>` that carries the inline width variable. */
function pageSection(page: MountedPage): HTMLElement {
  const section = page.container.querySelector<HTMLElement>('section');
  if (section === null) throw new Error('document page section is missing');
  return section;
}

/** Inline `--alter-doc-width`; empty when the page uses the token default. */
function docWidthVar(page: MountedPage): string {
  return pageSection(page).style.getPropertyValue('--alter-doc-width');
}

/** The centered body column the handle is attached to. */
function paper(page: MountedPage): HTMLElement {
  const article = page.container.querySelector<HTMLElement>('article');
  if (article === null) throw new Error('document paper is missing');
  return article;
}

/** A positive-size rect so the page can measure a layout that jsdom lacks. */
function rectOf(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    width,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

async function findHandle(): Promise<HTMLElement> {
  return screen.findByRole('separator', { name: HANDLE_LABEL });
}

function startDrag(handle: HTMLElement, clientX: number, pointerId = 1): void {
  fireEvent.pointerDown(handle, { button: 0, pointerId, clientX });
}

function moveDrag(handle: HTMLElement, clientX: number, pointerId = 1): void {
  fireEvent.pointerMove(handle, { pointerId, clientX });
}

function endDrag(handle: HTMLElement, pointerId = 1): void {
  fireEvent.pointerUp(handle, { pointerId });
}

describe('document page body width', () => {
  it('renders a vertical width handle and keeps the token default', async () => {
    const page = mountPage();
    const handle = await findHandle();

    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuemin')).toBe(String(MIN_DOC_WIDTH));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(MAX_DOC_WIDTH));
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(DEFAULT_DOC_WIDTH),
    );
    expect(handle.getAttribute('tabindex')).toBe('0');
    // No preference yet: no inline variable, the token stylesheet owns width.
    expect(docWidthVar(page)).toBe('');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBeNull();
  });

  it('widens the column while dragging the right edge (2px per pointer px)', async () => {
    const page = mountPage();
    const handle = await findHandle();

    startDrag(handle, 900);
    // jsdom cannot measure: the drag starts from the 760px fallback.
    moveDrag(handle, 920);
    expect(docWidthVar(page)).toBe('800px');
    moveDrag(handle, 940);
    expect(docWidthVar(page)).toBe('840px');
    expect(handle.getAttribute('aria-valuenow')).toBe('840');
  });

  it('ends the drag on pointerup and restores body cursor and selection', async () => {
    const page = mountPage();
    const handle = await findHandle();

    startDrag(handle, 900);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    moveDrag(handle, 940);
    expect(docWidthVar(page)).toBe('840px');

    endDrag(handle);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // A pointer that moves after the drag is released must not resize.
    moveDrag(handle, 1100);
    expect(docWidthVar(page)).toBe('840px');
  });

  it('persists the chosen width and restores it on the next mount', async () => {
    mountPage();
    const handle = await findHandle();
    startDrag(handle, 900);
    moveDrag(handle, 940);
    endDrag(handle);
    await settle();
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe('840');

    cleanup();

    const remounted = mountPage();
    await findHandle();
    expect(docWidthVar(remounted)).toBe('840px');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe('840');
  });

  it('resets to the default width on double click', async () => {
    const page = mountPage();
    const handle = await findHandle();
    startDrag(handle, 900);
    moveDrag(handle, 940);
    endDrag(handle);
    await settle();
    expect(docWidthVar(page)).toBe('840px');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe('840');

    fireEvent.dblClick(handle);
    await settle();

    expect(docWidthVar(page)).toBe('');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBeNull();
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(DEFAULT_DOC_WIDTH),
    );
  });

  it('resizes with the keyboard and clamps Home/End to the range', async () => {
    const page = mountPage();
    const handle = await findHandle();
    const press = async (init: Record<string, unknown>): Promise<void> => {
      fireEvent.keyDown(handle, init);
      await settle();
    };

    await press({ key: 'ArrowRight' });
    expect(docWidthVar(page)).toBe('776px');
    await press({ key: 'ArrowRight', shiftKey: true });
    expect(docWidthVar(page)).toBe('824px');
    await press({ key: 'ArrowLeft' });
    expect(docWidthVar(page)).toBe('808px');

    await press({ key: 'Home' });
    expect(docWidthVar(page)).toBe(`${MIN_DOC_WIDTH}px`);
    await press({ key: 'End' });
    expect(docWidthVar(page)).toBe(`${MAX_DOC_WIDTH}px`);
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe(String(MAX_DOC_WIDTH));
  });

  it('clamps a dragged width to the allowed range', async () => {
    const page = mountPage();
    const handle = await findHandle();

    startDrag(handle, 900);
    moveDrag(handle, 3000);
    expect(docWidthVar(page)).toBe(`${MAX_DOC_WIDTH}px`);
    endDrag(handle);

    startDrag(handle, 900, 2);
    moveDrag(handle, -1000, 2);
    expect(docWidthVar(page)).toBe(`${MIN_DOC_WIDTH}px`);
  });

  it('does not render the handle on an embedded page', async () => {
    localStorage.setItem(DOC_WIDTH_KEY, '840');
    const page = mountPage({ embedded: true });
    await settle();

    expect(screen.queryByRole('separator', { name: HANDLE_LABEL })).toBeNull();
    // The embedded preview still honours the stored preference; only the
    // handle (a page-level affordance) is gone.
    expect(docWidthVar(page)).toBe('840px');
  });

  it('caps the width at the measured column width', async () => {
    localStorage.setItem(DOC_WIDTH_KEY, String(MAX_DOC_WIDTH));
    const page = mountPage();
    const handle = await findHandle();
    expect(docWidthVar(page)).toBe(`${MAX_DOC_WIDTH}px`);

    // Pretend a real layout: 900px column + 10px/14px centering margins.
    // jsdom computes an unset `max-width` as `none`, which the page reads as a
    // collapsed (narrow) layout, so give the paper an explicit desktop value.
    const article = paper(page);
    article.style.maxWidth = '900px';
    article.style.marginLeft = '10px';
    article.style.marginRight = '14px';
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue(rectOf(900));
    fireEvent(window, new Event('resize'));
    await settle();

    // column width 924 → upper bound 924 - 2 * 12 = 900.
    expect(handle.getAttribute('aria-valuemax')).toBe('900');
    expect(handle.getAttribute('aria-valuenow')).toBe('900');
    expect(docWidthVar(page)).toBe('900px');
  });

  it('hides the handle when the layout collapses the column', async () => {
    const page = mountPage();
    // The handle lives inside the body column it resizes.
    const handle = await findHandle();
    const article = handle.closest<HTMLElement>('article');
    if (article === null) throw new Error('width handle is outside the paper');

    article.style.maxWidth = 'none';
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue(rectOf(900));
    fireEvent(window, new Event('resize'));
    await settle();

    expect(screen.queryByRole('separator', { name: HANDLE_LABEL })).toBeNull();
    // Collapsing is CSS's business; the page still keeps no inline preference.
    expect(docWidthVar(page)).toBe('');
  });

  it('starts the drag from the measured width and caps at the measured column', async () => {
    const page = mountPage();
    const handle = await findHandle();
    const article = paper(page);
    article.style.maxWidth = '700px';
    article.style.marginLeft = '112px';
    article.style.marginRight = '112px';
    const rect = vi
      .spyOn(article, 'getBoundingClientRect')
      .mockReturnValue(rectOf(700));
    fireEvent(window, new Event('resize'));
    await settle();

    // The layout changes again without a resize event: pointerdown must
    // re-measure (640 + 2 * 20 = 680 column → upper bound 656) instead of
    // reusing the last metrics.
    article.style.maxWidth = '640px';
    article.style.marginLeft = '20px';
    article.style.marginRight = '20px';
    rect.mockReturnValue(rectOf(640));

    startDrag(handle, 900);
    moveDrag(handle, 940);
    expect(docWidthVar(page)).toBe('656px');
  });

  it('keeps a wider stored preference when the column cannot fit it', async () => {
    localStorage.setItem(DOC_WIDTH_KEY, String(MAX_DOC_WIDTH));
    const page = mountPage();
    const handle = await findHandle();
    const article = paper(page);
    article.style.maxWidth = '700px';
    article.style.marginLeft = '112px';
    article.style.marginRight = '112px';
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue(rectOf(700));
    fireEvent(window, new Event('resize'));
    await settle();

    // Displayed width is capped at the measured 900, but the preference stays
    // 1120: widening commands in a constrained layout must be no-ops.
    expect(docWidthVar(page)).toBe('900px');
    fireEvent.keyDown(handle, { key: 'End' });
    await settle();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await settle();
    expect(docWidthVar(page)).toBe('900px');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe(String(MAX_DOC_WIDTH));

    // Deliberately narrowing does rewrite the preference.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await settle();
    expect(docWidthVar(page)).toBe('884px');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe('884');
  });

  it('does not reset when the double click is synthesized by a drag', async () => {
    const page = mountPage();
    const handle = await findHandle();
    startDrag(handle, 900);
    moveDrag(handle, 940);
    endDrag(handle);
    await settle();
    expect(docWidthVar(page)).toBe('840px');

    // Pointer capture makes the browser fire a click after the drag; two fast
    // drags would otherwise synthesize a resetting dblclick.
    fireEvent.click(handle);
    fireEvent.dblClick(handle);
    await settle();

    expect(docWidthVar(page)).toBe('840px');
    expect(handle.getAttribute('aria-valuenow')).toBe('840');
  });

  it('ignores non-primary pointer presses', async () => {
    const page = mountPage();
    const handle = await findHandle();

    fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 940 });
    await settle();

    expect(docWidthVar(page)).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('ends the drag when the pointer is cancelled', async () => {
    const page = mountPage();
    const handle = await findHandle();

    startDrag(handle, 900);
    moveDrag(handle, 940);
    expect(docWidthVar(page)).toBe('840px');
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    await settle();

    expect(document.body.style.cursor).toBe('');
    moveDrag(handle, 1100);
    expect(docWidthVar(page)).toBe('840px');
  });

  it('does not rewrite a wider preference when dragging against the limit', async () => {
    localStorage.setItem(DOC_WIDTH_KEY, String(MAX_DOC_WIDTH));
    const page = mountPage();
    const handle = await findHandle();
    const article = paper(page);
    article.style.maxWidth = '900px';
    article.style.marginLeft = '12px';
    article.style.marginRight = '12px';
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue(rectOf(900));
    fireEvent(window, new Event('resize'));
    await settle();

    // Displayed width is capped at 900; dragging further right is a no-op.
    expect(docWidthVar(page)).toBe('900px');
    startDrag(handle, 900);
    moveDrag(handle, 920);
    await settle();
    expect(docWidthVar(page)).toBe('900px');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe(String(MAX_DOC_WIDTH));

    // Dragging left is a deliberate narrowing and does rewrite the preference.
    moveDrag(handle, 880);
    await settle();
    expect(docWidthVar(page)).toBe('860px');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBe('860');
  });

  it('resets on a plain double click after a drag has settled', async () => {
    const page = mountPage();
    const handle = await findHandle();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    startDrag(handle, 900);
    moveDrag(handle, 940);
    endDrag(handle);
    // The browser still fires a click after the drag; once the guard window
    // passed, that stale gesture must not swallow the next double click.
    fireEvent.click(handle);
    await settle();
    expect(docWidthVar(page)).toBe('840px');
    now.mockReturnValue(2_000);

    // A later plain click must not inherit the previous gesture's "dragged"
    // state, or the resetting double click would be swallowed forever.
    startDrag(handle, 900);
    endDrag(handle);
    fireEvent.click(handle);
    fireEvent.dblClick(handle);
    await settle();

    expect(docWidthVar(page)).toBe('');
    expect(localStorage.getItem(DOC_WIDTH_KEY)).toBeNull();
  });
});
