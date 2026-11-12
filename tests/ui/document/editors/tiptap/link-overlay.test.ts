// @vitest-environment jsdom
/**
 * Link action bar parity (`docs/acceptance/editor-experience-p0-p6.md` §2).
 *
 * Frozen behaviour: hovering or focusing `a[data-web-link]` / `[data-link-card]`
 * shows a dark bar with 转为卡片/转为行内 and 编辑; it hides 180ms after the
 * pointer leaves, positions itself 42px above the link and clamps into the
 * viewport. Conversion keeps the URL and rewrites the body into the other AST
 * shape; 编辑 reports the link so the page can render its dialog, and clicking a
 * link opens it (the page routes web links / document links when it provides
 * callbacks, otherwise a new tab is opened).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import {
  createKernelEditor,
  kernelExtensions,
} from '../../../../../src/document/editors/tiptap/editor';
import { blocksToPmDoc, pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import {
  createLinkOverlay,
  type LinkOverlayHandlers,
} from '../../../../../src/document/editors/tiptap/overlays';
import { KERNEL_CLASS } from '../../../../../src/document/editors/tiptap/classes';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout: the bar measures its target with getBoundingClientRect.
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
Element.prototype.getBoundingClientRect = zeroRect as never;

/** A rectangle used to prove the frozen clamp formulas. */
function rect(left: number, top: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + 40,
    bottom: top + 18,
    width: 40,
    height: 18,
    toJSON: () => ({}),
  } as DOMRect;
}

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function paragraph(id: string, text: string): BlockNode {
  return block(id, 'paragraph', {}, { content: [{ type: 'text', text }] });
}

function inlineLinkDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('blk_p', 'paragraph', {}, {
        content: [
          { type: 'text', text: '见 ' },
          {
            type: 'text',
            text: '文档',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
          },
          { type: 'text', text: '之后' },
        ],
      }),
    ],
  };
}

function cardDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('blk_bm', 'bookmark', {
        url: 'https://example.com/b',
        title: '示例站',
        description: '说明',
      }),
      paragraph('blk_tail', '之后'),
    ],
  };
}

function docLinkDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      paragraph('blk_p', '正文'),
      block('blk_doc', 'docLink', { docId: 'doc_123', title: '内链文档' }),
    ],
  };
}

function fileDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('blk_file', 'file', {
        assetId: 'asset_file',
        name: '报.pdf',
        mime: 'application/pdf',
        bytes: 1024,
      }),
    ],
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll(`.${KERNEL_CLASS.linkBar}`).forEach((node) => node.remove());
});

function mount(
  doc: AlterDoc,
  extra: {
    onUpdate?: () => void;
    onLinkEdit?: (detail: {
      kind: 'card' | 'inline';
      href: string;
      pos: number;
      label?: string;
    }) => void;
  } = {},
) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc, ...extra });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/**
 * Mount one link bar on a bare kernel editor.
 *
 * Editor.ts owns the production wiring; this harness proves the bar's own
 * callback routing (web link / document link) without depending on it.
 */
function mountBareOverlay(doc: AlterDoc, handlers: LinkOverlayHandlers = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: kernelExtensions(),
    content: blocksToPmDoc(doc.blocks).value.toJSON(),
  });
  const overlay = createLinkOverlay(editor, handlers);
  cleanups.push(() => {
    overlay.destroy();
    editor.destroy();
    element.remove();
  });
  return { editor, overlay };
}

/** The link bar (the table bar has its own label). */
function linkBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="链接操作"]');
}

function pressBar(label: string): void {
  const button = linkBar()?.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  expect(button, `button ${label}`).not.toBeNull();
  button!.click();
}

function hover(element: Element): void {
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

function click(element: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

/** Position of the first link-marked text run (what 编辑 reports). */
function linkRunPos(kernel: ReturnType<typeof mount> | { editor: Editor }): number {
  let found = -1;
  kernel.editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.marks.some((mark) => mark.type.name === 'link')) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

describe('link bar', () => {
  it('exists as a body-level overlay with the frozen shell', () => {
    mount(inlineLinkDoc());
    const bar = linkBar();
    expect(bar).not.toBeNull();
    expect(bar?.className).toBe(KERNEL_CLASS.linkBar);
    expect(bar?.getAttribute('role')).toBe('group');
    expect(bar?.style.display).toBe('none');
  });

  it('offers 转为卡片 / 编辑 with the frozen aria labels for an inline link', () => {
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]');
    expect(anchor, 'inline link is rendered with data-web-link').not.toBeNull();
    hover(anchor!);
    const bar = linkBar()!;
    expect(bar.style.display).not.toBe('none');
    const convert = bar.querySelector<HTMLButtonElement>(
      '[aria-label="转为卡片链接"]',
    );
    expect(convert).not.toBeNull();
    expect(convert!.textContent).toBe('转为卡片');
    expect(convert!.title).toBe('转为卡片链接');
    const edit = bar.querySelector<HTMLButtonElement>('[aria-label="编辑链接"]');
    expect(edit).not.toBeNull();
    expect(edit!.textContent).toBe('编辑');
  });

  it('offers 转为行内 with the frozen aria label for a card', () => {
    const kernel = mount(cardDoc());
    const card = kernel.editor.view.dom.querySelector('a[data-link-card]');
    expect(card, 'card is rendered as a[data-link-card]').not.toBeNull();
    hover(card!);
    const button = linkBar()?.querySelector<HTMLButtonElement>(
      '[aria-label="转为行内链接"]',
    );
    expect(button).not.toBeNull();
    expect(button!.textContent).toBe('转为行内');
    expect(button!.title).toBe('转为行内链接');
  });

  it('does not offer the bar for a document link', () => {
    const kernel = mount(docLinkDoc());
    const docLink = kernel.editor.view.dom.querySelector('a[data-doc-link]');
    expect(docLink).not.toBeNull();
    hover(docLink!);
    expect(linkBar()?.style.display).toBe('none');
  });

  it('does not offer the bar for a bare anchor without data-web-link', () => {
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]')!;
    anchor.removeAttribute('data-web-link');
    hover(anchor);
    expect(linkBar()?.style.display).toBe('none');
  });

  it('shows on focus as well as hover', () => {
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]')!;
    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(linkBar()?.style.display).not.toBe('none');
  });

  it('hides 180ms after the pointer leaves and cancels while the bar is hovered', () => {
    vi.useFakeTimers();
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]')!;
    hover(anchor);
    expect(linkBar()?.style.display).not.toBe('none');
    kernel.editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(179);
    expect(linkBar()?.style.display).not.toBe('none');
    linkBar()!.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(linkBar()?.style.display).not.toBe('none');
    linkBar()!.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(180);
    expect(linkBar()?.style.display).toBe('none');
  });

  it('positions itself 42px above the link with the frozen clamp', () => {
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]')!;
    anchor.getBoundingClientRect = () => rect(100, 200);
    hover(anchor);
    expect(linkBar()?.style.left).toBe('100px');
    expect(linkBar()?.style.top).toBe('158px');
  });

  it('clamps inside the viewport at the right edge and top', () => {
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]')!;
    anchor.getBoundingClientRect = () => rect(5000, 5);
    hover(anchor);
    expect(linkBar()?.style.left).toBe(`${window.innerWidth - 260}px`);
    expect(linkBar()?.style.top).toBe('10px');
  });

  it('keeps the selection while the bar is pressed', () => {
    const kernel = mount(inlineLinkDoc());
    hover(kernel.editor.view.dom.querySelector('a[data-web-link]')!);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    linkBar()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('converts an inline link into a card that keeps the anchor text as title', () => {
    const onUpdate = vi.fn();
    const kernel = mount(inlineLinkDoc(), { onUpdate });
    hover(kernel.editor.view.dom.querySelector('a[data-web-link]')!);
    pressBar('转为卡片链接');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    // bookmark cards are block atoms: the line is split around the card.
    expect(blocks.map((item) => item.type)).toEqual([
      'paragraph',
      'bookmark',
      'paragraph',
    ]);
    expect(blocks[0]?.content?.[0]).toEqual({ type: 'text', text: '见 ' });
    expect(blocks[1]?.attrs['url']).toBe('https://example.com/a');
    expect(blocks[1]?.attrs['title']).toBe('文档');
    expect(blocks[1]?.attrs['description']).toBe('https://example.com/a');
    expect(blocks[2]?.content?.[0]).toEqual({ type: 'text', text: '之后' });
    // The original block keeps its id; the split-off line gets a fresh one.
    expect(blocks[0]?.id).toBe('blk_p');
    expect(blocks[2]?.id).not.toBe('blk_p');
    expect(blocks[2]?.id).not.toBe('');
    expect(onUpdate).toHaveBeenCalled();
    // The bar hides once the link becomes a card.
    expect(linkBar()?.style.display).toBe('none');
  });

  it('converts a card back into an inline link that keeps the card title', () => {
    const onUpdate = vi.fn();
    const kernel = mount(cardDoc(), { onUpdate });
    hover(kernel.editor.view.dom.querySelector('a[data-link-card]')!);
    pressBar('转为行内链接');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'paragraph']);
    const content = blocks[0]?.content ?? [];
    expect(content).toHaveLength(1);
    const text = content[0];
    expect(text?.type).toBe('text');
    expect(text?.type === 'text' ? text.text : '').toBe('示例站');
    expect(
      text?.type === 'text'
        ? text.marks?.find((mark) => mark.type === 'link')?.attrs?.['href']
        : undefined,
    ).toBe('https://example.com/b');
    expect(onUpdate).toHaveBeenCalled();
    expect(
      kernel.editor.view.dom.querySelector('a[data-web-link]'),
    ).not.toBeNull();
  });

  it('reports 编辑 with the link fields and its display text', () => {
    const onLinkEdit = vi.fn();
    const kernel = mount(inlineLinkDoc(), { onLinkEdit });
    hover(kernel.editor.view.dom.querySelector('a[data-web-link]')!);
    pressBar('编辑链接');
    expect(onLinkEdit).toHaveBeenCalledWith({
      kind: 'inline',
      href: 'https://example.com/a',
      pos: expect.any(Number),
      label: '文档',
    });
    expect(linkBar()?.style.display).toBe('none');
  });

  it('reports the card title as the display text when editing a card', () => {
    const onLinkEdit = vi.fn();
    const kernel = mount(cardDoc(), { onLinkEdit });
    hover(kernel.editor.view.dom.querySelector('a[data-link-card]')!);
    pressBar('编辑链接');
    expect(onLinkEdit).toHaveBeenCalledWith({
      kind: 'card',
      href: 'https://example.com/b',
      pos: expect.any(Number),
      label: '示例站',
    });
  });

  it('writes an edited inline link back into the document', () => {
    const kernel = mount(inlineLinkDoc());
    kernel.applyLinkEdit({
      kind: 'inline',
      pos: linkRunPos(kernel),
      href: 'https://example.com/renamed',
      label: '新文字',
    });
    const blocks = pmDocToBlocks(kernel.capture()).value;
    const runs = (blocks[0]?.content ?? []).filter(
      (node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'link'),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.type === 'text' ? runs[0].text : '').toBe('新文字');
    expect(
      runs[0]?.type === 'text'
        ? runs[0].marks?.find((mark) => mark.type === 'link')?.attrs?.['href']
        : undefined,
    ).toBe('https://example.com/renamed');
  });

  it('writes an edited card back and recomputes its description from the URL', () => {
    const kernel = mount(cardDoc());
    kernel.applyLinkEdit({
      kind: 'card',
      pos: 0,
      href: 'https://example.com/updated',
      label: '更新标题',
    });
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.id).toBe('blk_bm');
    expect(blocks[0]?.attrs['url']).toBe('https://example.com/updated');
    expect(blocks[0]?.attrs['title']).toBe('更新标题');
    expect(blocks[0]?.attrs['description']).toBe('https://example.com/updated');
    expect(blocks[1]?.id).toBe('blk_tail');
  });

  it('falls back to the URL host name when the dialog label is emptied', () => {
    const kernel = mount(cardDoc());
    kernel.applyLinkEdit({
      kind: 'card',
      pos: 0,
      href: 'https://www.example.com/only-url',
      label: '   ',
    });
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks[0]?.attrs['title']).toBe('example.com');
  });

  it('opens an inline web link in a new tab when the page provides no callback', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[data-web-link]')!;
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens a card in a new tab when the page provides no callback', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const kernel = mount(cardDoc());
    click(kernel.editor.view.dom.querySelector('a[data-link-card]')!);
    expect(open).toHaveBeenCalledWith(
      'https://example.com/b',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('routes web-link clicks to the page callback when one is provided', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpenWeb = vi.fn();
    const { editor } = mountBareOverlay(inlineLinkDoc(), { onOpenWeb });
    click(editor.view.dom.querySelector('a[data-web-link]')!);
    expect(onOpenWeb).toHaveBeenCalledWith('https://example.com/a');
    expect(open).not.toHaveBeenCalled();
  });

  it('routes card clicks to the page callback when one is provided', () => {
    const onOpenWeb = vi.fn();
    const { editor } = mountBareOverlay(cardDoc(), { onOpenWeb });
    click(editor.view.dom.querySelector('a[data-link-card]')!);
    expect(onOpenWeb).toHaveBeenCalledWith('https://example.com/b');
  });

  it('routes document links to the page router', () => {
    const onOpenDoc = vi.fn();
    const { editor } = mountBareOverlay(docLinkDoc(), { onOpenDoc });
    const docLink = editor.view.dom.querySelector('a[data-doc-link]')!;
    const event = click(docLink);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenDoc).toHaveBeenCalledWith('doc_123');
  });

  it('opens file cards in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { editor } = mountBareOverlay(fileDoc());
    const file = editor.view.dom.querySelector('[data-file]') as HTMLElement;
    expect(file, 'file card is rendered').not.toBeNull();
    click(file);
    expect(open).toHaveBeenCalledWith(
      file.getAttribute('data-href'),
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('removes its overlay when the kernel is destroyed', () => {
    const kernel = mount(inlineLinkDoc());
    expect(linkBar()).not.toBeNull();
    kernel.destroy();
    expect(linkBar()).toBeNull();
  });
});