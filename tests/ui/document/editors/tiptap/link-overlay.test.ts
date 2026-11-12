// @vitest-environment jsdom
/**
 * Link overlay in the AST-native kernel.
 *
 * Parity gate: hovering a link offers 转为卡片 / 转为行内 and 编辑. Conversion must
 * preserve the URL and rewrite the body into the other AST shape (a `link` mark
 * or a `bookmark` card), and 编辑 must report the link so the page can open its
 * dialog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

const zeroRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
Element.prototype.getBoundingClientRect = zeroRect as never;

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
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
    ],
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll('.linkBar').forEach((node) => node.remove());
});

function mount(doc: AlterDoc, extra: { onLinkEdit?: (detail: { kind: 'card' | 'inline'; href: string }) => void } = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc, ...extra });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** The link bar (the table bar has its own label). */
function linkBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="链接操作"]');
}

function clickBar(label: string): void {
  const target = linkBar()?.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  expect(target, `button ${label}`).not.toBeNull();
  target!.click();
}

describe('link bar', () => {
  it('exists as a body-level overlay with the frozen label', () => {
    mount(inlineLinkDoc());
    const bar = linkBar();
    expect(bar).not.toBeNull();
    expect(bar?.className).toBe('linkBar');
    expect(bar?.getAttribute('role')).toBe('group');
    expect(bar?.style.display).toBe('none');
  });

  it('offers 转为卡片 / 编辑 when an inline link is hovered', () => {
    const kernel = mount(inlineLinkDoc());
    const anchor = kernel.editor.view.dom.querySelector('a[href]');
    expect(anchor).not.toBeNull();
    anchor!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const bar = linkBar()!;
    expect(bar.style.display).not.toBe('none');
    expect(bar.querySelector('[aria-label="转为卡片"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="编辑"]')).not.toBeNull();
  });

  it('offers 转为行内 when a card is hovered', () => {
    const kernel = mount(cardDoc());
    const card = kernel.editor.view.dom.querySelector('[data-block-type="bookmark"]');
    expect(card).not.toBeNull();
    card!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(linkBar()?.querySelector('[aria-label="转为行内"]')).not.toBeNull();
  });

  it('converts an inline link into a bookmark card, keeping the URL', () => {
    const kernel = mount(inlineLinkDoc());
    kernel.editor.view.dom
      .querySelector('a[href]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    clickBar('转为卡片');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    const card = blocks.find((item) => item.type === 'bookmark');
    expect(card).toBeDefined();
    expect(card?.attrs['url']).toBe('https://example.com/a');
  });

  it('converts a card back into an inline link, keeping the URL', () => {
    const kernel = mount(cardDoc());
    kernel.editor.view.dom
      .querySelector('[data-block-type="bookmark"]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    clickBar('转为行内');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.some((item) => item.type === 'bookmark')).toBe(false);
    const link = blocks
      .flatMap((item) => item.content ?? [])
      .flatMap((node) => (node.type === 'text' ? node.marks ?? [] : []))
      .find((mark) => mark.type === 'link');
    expect(link?.attrs?.href).toBe('https://example.com/b');
  });

  it('reports 编辑 with the hovered link so the page can open its dialog', () => {
    const onLinkEdit = vi.fn();
    const kernel = mount(cardDoc(), { onLinkEdit });
    kernel.editor.view.dom
      .querySelector('[data-block-type="bookmark"]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    clickBar('编辑');
    expect(onLinkEdit).toHaveBeenCalledWith({
      kind: 'card',
      href: 'https://example.com/b',
      // The kernel reports the node position so the dialog result can be
      // written back to the same link.
      pos: expect.any(Number),
    });
  });

  it('hides again when the pointer leaves the body', () => {
    const kernel = mount(inlineLinkDoc());
    const dom = kernel.editor.view.dom;
    dom.querySelector('a[href]')!.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );
    expect(linkBar()?.style.display).not.toBe('none');
    dom.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    expect(linkBar()?.style.display).toBe('none');
  });

  it('removes its overlay when the kernel is destroyed', () => {
    const kernel = mount(inlineLinkDoc());
    expect(linkBar()).not.toBeNull();
    kernel.destroy();
    expect(linkBar()).toBeNull();
  });

  it('writes an edited inline link back into the document', () => {
    const kernel = mount(inlineLinkDoc());
    kernel.editor.view.dom
      .querySelector('a[href]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    // The dialog result arrives from the page.
    kernel.applyLinkEdit({
      kind: 'inline',
      pos: linkPos(kernel),
      href: 'https://example.com/renamed',
      label: '新文字',
    });
    const blocks = pmDocToBlocks(kernel.capture()).value;
    const runs = blocks
      .flatMap((item) => item.content ?? [])
      .filter((node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'link'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.type === 'text' ? runs[0].text : '').toBe('新文字');
    const link = runs[0]?.type === 'text'
      ? runs[0].marks?.find((mark) => mark.type === 'link')
      : undefined;
    expect(link?.attrs?.href).toBe('https://example.com/renamed');
  });

  it('writes an edited card back without touching its ids or siblings', () => {
    // A trailing paragraph keeps the card from being the last block, which
    // ProseMirror would otherwise have to pad with a filler paragraph.
    const withTail: AlterDoc = cardDoc();
    withTail.blocks.push(
      block('blk_tail', 'paragraph', {}, {
        content: [{ type: 'text', text: '之后' }],
      }),
    );
    const kernel = mount(withTail);
    kernel.editor.view.dom
      .querySelector('[data-block-type="bookmark"]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
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
    // The sibling below is untouched.
    expect(blocks[1]?.id).toBe('blk_tail');
  });

  it('falls back to the URL when the label is emptied', () => {
    const kernel = mount(cardDoc());
    kernel.applyLinkEdit({
      kind: 'card',
      pos: 0,
      href: 'https://example.com/only-url',
      label: '   ',
    });
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks[0]?.attrs['title']).toBe('https://example.com/only-url');
  });
});

/** Position of the inline link's text (what `onLinkEdit` reports). */
function linkPos(kernel: ReturnType<typeof mount>): number {
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