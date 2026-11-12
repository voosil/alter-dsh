// @vitest-environment jsdom
/**
 * Slash menu and `---` divider parity in the AST-native kernel.
 *
 * These are the two highest-frequency entry points of the frozen editor, so the
 * new kernel must reproduce them exactly: same command set and search ranking,
 * same keyboard flow, same immediate `---` conversion with no Enter required.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKernelEditor } from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import { SLASH_COMMANDS, filterSlashCommands } from '../../../../../src/document/editors/slash-commands';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

// jsdom has no layout engine, so ProseMirror's caret measurement
// (`coordsAtPos` → Range.getClientRects) is missing. The menu positions itself
// from that measurement, so the shim stands in for layout.
const zeroRects = () => [] as unknown as DOMRectList;
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
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = zeroRects as never;
}
if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = zeroRects as never;
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = zeroRect as never;
}
if (typeof Element.prototype.getBoundingClientRect !== 'function') {
  Element.prototype.getBoundingClientRect = zeroRect as never;
}

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
  document.querySelectorAll('.slashMenu').forEach((node) => node.remove());
});

function mount(blocks: BlockNode[]) {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: doc(blocks) });
  cleanups.push(() => {
    kernel.destroy();
    element.remove();
  });
  return kernel;
}

/** Type text at the end of the document, the way ProseMirror receives input. */
function typeAtEnd(
  kernel: ReturnType<typeof mount>,
  text: string,
): void {
  const view = kernel.editor.view;
  const end = view.state.doc.content.size;
  view.dispatch(view.state.tr.insertText(text, end - 1));
}

describe('slash command table', () => {
  it('offers the same commands, in the same order, as the frozen editor', () => {
    expect(SLASH_COMMANDS.map((command) => command.id)).toEqual([
      'text',
      'h1',
      'h2',
      'h3',
      'bullet',
      'ordered',
      'todo',
      'quote',
      'code',
      'divider',
      'table',
      'image',
      'file',
    ]);
    expect(SLASH_COMMANDS.map((command) => command.label)).toEqual([
      '正文',
      '标题 1',
      '标题 2',
      '标题 3',
      '无序列表',
      '有序列表',
      '待办',
      '引用',
      '代码块',
      '分割线',
      '表格',
      '图片',
      '文件',
    ]);
  });

  it('returns every command for an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('ranks exact matches before prefixes and substrings', () => {
    // "h1" matches id `h1` exactly and is a prefix of keyword `heading1`.
    const results = filterSlashCommands('h1');
    expect(results[0]?.id).toBe('h1');
  });

  it('matches Chinese labels', () => {
    const results = filterSlashCommands('列表');
    expect(results.map((command) => command.id)).toEqual(
      expect.arrayContaining(['bullet', 'ordered']),
    );
  });

  it('matches a subsequence, like the frozen search', () => {
    // The frozen editor's own example: "/tdo" still finds the "todo" keyword.
    const results = filterSlashCommands('tdo');
    expect(results.some((command) => command.id === 'todo')).toBe(true);
  });

  it('offers nothing for a query that matches no candidate', () => {
    expect(filterSlashCommands('zzzzqqq')).toEqual([]);
  });
});

describe('slash menu in the editor', () => {
  it('opens on typing `/` and lists the commands', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    typeAtEnd(kernel, '/');
    const menu = document.querySelector('.slashMenu');
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute('role')).toBe('listbox');
    expect(menu?.querySelectorAll('.slashItem')).toHaveLength(
      SLASH_COMMANDS.length,
    );
  });

  it('filters as the query grows and marks the active item', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    typeAtEnd(kernel, '/h');
    const menu = document.querySelector('.slashMenu')!;
    const items = [...menu.querySelectorAll('.slashItem')];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(SLASH_COMMANDS.length);
    expect(menu.querySelector('[data-active]')).not.toBeNull();
  });

  it('closes on Escape', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    typeAtEnd(kernel, '/');
    const view = kernel.editor.view;
    const handled = kernel.editor.view.someProp('handleKeyDown', (handler) =>
      handler(view, new KeyboardEvent('keydown', { key: 'Escape' }) as never),
    );
    expect(handled).toBe(true);
  });

  it('is not offered outside the start of a line', () => {
    const kernel = mount([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '文字' }],
      }),
    ]);
    typeAtEnd(kernel, '/');
    // The `/` is typed after existing text, so no menu appears.
    expect(document.querySelector('.slashMenu')).toBeNull();
  });
});

/** Type text through ProseMirror's text-input chain (where input rules run). */
function typeText(
  kernel: ReturnType<typeof mount>,
  text: string,
): { handled: boolean } {
  const view = kernel.editor.view;
  const handled = view.someProp('handleTextInput', (handler) =>
    handler(view, 1, 1, text),
  );
  return { handled: handled === true };
}

describe('divider input rule', () => {
  it('turns a line holding `---` into a divider without pressing Enter', () => {
    const kernel = mount([block('blk_p', 'paragraph')]);
    // The frozen editor converts as soon as the third dash lands, so the rule
    // must run on text input rather than on Enter.
    typeText(kernel, '---');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.some((item) => item.type === 'divider')).toBe(true);
    // A paragraph follows the divider so typing can continue.
    expect(blocks.at(-1)?.type).toBe('paragraph');
  });

  it('keeps `---` as text inside a code block', () => {
    const kernel = mount([
      block('blk_code', 'codeBlock', { lang: 'yml' }, {
        content: [{ type: 'text', text: '' }],
      }),
    ]);
    typeText(kernel, '---');
    const blocks = pmDocToBlocks(kernel.capture()).value;
    expect(blocks.some((item) => item.type === 'divider')).toBe(false);
  });
});