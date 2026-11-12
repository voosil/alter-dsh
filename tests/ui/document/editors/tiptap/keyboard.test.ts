// @vitest-environment jsdom
/**
 * Keyboard and markdown-shortcut parity.
 *
 * The frozen editor implements `Mod-U` by hand and accepts `》` plus both task
 * markers; the new kernel must keep those working, otherwise a user typing their
 * usual shortcuts silently loses formatting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

const zeroRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
Element.prototype.getBoundingClientRect = zeroRect as never;
const zeroRects = () => [] as unknown as DOMRectList;
Range.prototype.getClientRects = zeroRects as never;
Element.prototype.getClientRects = zeroRects as never;
Range.prototype.getBoundingClientRect = zeroRect as never;

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

function textDoc(text: string): AlterDoc {
  return doc([
    block('blk_p', 'paragraph', {}, {
      content: [{ type: 'text', text }],
    }),
  ]);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
});

function mount(docValue: AlterDoc) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: docValue });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** Select the whole paragraph text. */
function selectAll(kernel: ReturnType<typeof mount>, length: number): void {
  const view = kernel.editor.view;
  const selection = (
    view.state.selection.constructor as unknown as {
      create(doc: unknown, from: number, to: number): never;
    }
  ).create(view.state.doc, 1, 1 + length);
  view.dispatch(view.state.tr.setSelection(selection));
}

/** Run one keyboard shortcut through the editor's binding chain. */
function pressKey(
  kernel: ReturnType<typeof mount>,
  init: KeyboardEventInit,
): boolean {
  const view = kernel.editor.view;
  const handled = kernel.editor.view.someProp('handleKeyDown', (handler) =>
    handler(view, new KeyboardEvent('keydown', init) as never),
  );
  return handled === true;
}

describe('inline mark shortcuts', () => {
  it('Mod-U toggles underline (the frozen editor implements it by hand)', () => {
    const kernel = mount(textDoc('下划线文字'));
    selectAll(kernel, '下划线文字'.length);
    const handled = pressKey(kernel, { key: 'u', ctrlKey: true });
    expect(handled).toBe(true);
    const content = pmDocToBlocks(kernel.capture()).value[0]?.content ?? [];
    expect(
      content.some(
        (node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'underline'),
      ),
    ).toBe(true);
  });
});

describe('line conversion rules', () => {
  /** Type text into the line through ProseMirror's text-input chain. */
  function typeText(kernel: ReturnType<typeof mount>, text: string): boolean {
    const view = kernel.editor.view;
    const handled = view.someProp('handleTextInput', (handler) =>
      handler(view, 1, 1, text),
    );
    return handled === true;
  }

  it('turns `》` plus space into a blockquote', () => {
    const kernel = mount(doc([block('blk_p', 'paragraph')]));
    typeText(kernel, '》 ');
    const types = pmDocToBlocks(kernel.capture()).value.map((item) => item.type);
    expect(types).toContain('blockquote');
  });

  it('turns `[]` plus space into a task list', () => {
    const kernel = mount(doc([block('blk_p', 'paragraph')]));
    typeText(kernel, '[] ');
    const types = pmDocToBlocks(kernel.capture()).value.map((item) => item.type);
    expect(types).toContain('taskList');
  });

  it('turns `[ ]` plus space into a task list too', () => {
    const kernel = mount(doc([block('blk_p', 'paragraph')]));
    typeText(kernel, '[ ] ');
    const types = pmDocToBlocks(kernel.capture()).value.map((item) => item.type);
    expect(types).toContain('taskList');
  });
});