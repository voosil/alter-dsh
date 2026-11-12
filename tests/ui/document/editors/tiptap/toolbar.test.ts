// @vitest-environment jsdom
/**
 * Floating format toolbar in the AST-native kernel.
 *
 * Parity gate: selecting text must raise the bar, each button must toggle its
 * mark in the document, the pressed state must follow the selection, and the bar
 * must disappear with the kernel so a swap leaves no orphan overlay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import {
  TOOLBAR_MARKS,
  markFormatState,
  wordCount,
} from '../../../../../src/document/editors/tiptap/toolbar';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout engine; the toolbar measures the selection through
// ProseMirror's `coordsAtPos`.
const zeroRects = () => [] as unknown as DOMRectList;
const zeroRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
if (typeof Range.prototype.getClientRects !== 'function') Range.prototype.getClientRects = zeroRects as never;
if (typeof Element.prototype.getClientRects !== 'function') Element.prototype.getClientRects = zeroRects as never;
if (typeof Range.prototype.getBoundingClientRect !== 'function') Range.prototype.getBoundingClientRect = zeroRect as never;
if (typeof Element.prototype.getBoundingClientRect !== 'function') Element.prototype.getBoundingClientRect = zeroRect as never;

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function doc(blocks: BlockNode[]): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision: 1, blocks };
}

function textDoc(): AlterDoc {
  return doc([
    block('blk_p', 'paragraph', {}, {
      content: [{ type: 'text', text: '这是一段正文内容' }],
    }),
  ]);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll('.floating, .wordCount').forEach((node) => node.remove());
});

function mount(docValue: AlterDoc, extra: Partial<Parameters<typeof createKernelEditor>[0]> = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: docValue, ...extra });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

describe('toolbar geometry and presence', () => {
  it('renders the same controls as the frozen bar', () => {
    mount(textDoc());
    const bar = document.querySelector('.floating');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('role')).toBe('toolbar');
    expect(bar?.getAttribute('aria-label')).toBe('文本格式');
    // 文本类型 + one button per mark + 添加评论.
    expect(bar?.querySelectorAll('.toolButton')).toHaveLength(
      TOOLBAR_MARKS.length + 2,
    );
    expect(bar?.querySelectorAll('.toolDivider')).toHaveLength(2);
    for (const mark of TOOLBAR_MARKS) {
      expect(bar?.querySelector(`[data-mark="${mark}"]`)).not.toBeNull();
    }
    expect(bar?.querySelector('[aria-label="添加评论"]')).not.toBeNull();
  });

  it('starts hidden when the caret is collapsed', () => {
    mount(textDoc());
    const bar = document.querySelector<HTMLElement>('.floating');
    expect(bar?.style.display).toBe('none');
  });

  it('is removed when the kernel is destroyed', () => {
    const kernel = mount(textDoc());
    expect(document.querySelector('.floating')).not.toBeNull();
    kernel.destroy();
    expect(document.querySelector('.floating')).toBeNull();
    expect(document.querySelector('.wordCount')).toBeNull();
  });
});

describe('marks and state', () => {
  it('reports none for a collapsed selection', () => {
    const kernel = mount(textDoc());
    for (const mark of TOOLBAR_MARKS) {
      expect(markFormatState(kernel.editor, mark)).toBe('none');
    }
  });

  it('toggles a mark through the manifest mark commands', () => {
    const kernel = mount(textDoc());
    const view = kernel.editor.view;
    // Select the paragraph text (positions 1..len+1) and apply bold.
    view.dispatch(view.state.tr.setSelection(
      // TextSelection over the first paragraph.
      (view.state.selection.constructor as never as {
        create(doc: unknown, from: number, to: number): never;
      }).create(view.state.doc, 1, 1 + '这是一段正文内容'.length),
    ));
    kernel.editor.chain().focus().toggleMark('bold').run();
    const captured = pmDocToBlocks(kernel.capture()).value;
    const content = captured[0]?.content ?? [];
    expect(content.some((node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'bold'))).toBe(true);
  });

  it('counts characters the way the footer shows them', () => {
    const kernel = mount(textDoc());
    expect(wordCount(kernel.editor)).toBe('这是一段正文内容'.length);
  });

  it('ignores whitespace in the count', () => {
    const kernel = mount(doc([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: 'a b c' }],
      }),
    ]));
    expect(wordCount(kernel.editor)).toBe(3);
  });
});

describe('comment button', () => {
  it('asks the page to start a comment with the selected text', () => {
    const onComment = vi.fn();
    const kernel = mount(textDoc(), { onComment });
    const view = kernel.editor.view;
    view.dispatch(view.state.tr.setSelection(
      (view.state.selection.constructor as never as {
        create(doc: unknown, from: number, to: number): never;
      }).create(view.state.doc, 1, 1 + '这是一段'.length),
    ));
    // Selection updates re-show the bar.
    const bar = document.querySelector<HTMLElement>('.floating')!;
    const button = bar.querySelector<HTMLButtonElement>('[aria-label="添加评论"]')!;
    button.click();
    expect(onComment).toHaveBeenCalledWith('这是一段');
  });
});

