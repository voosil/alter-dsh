// @vitest-environment jsdom
/**
 * Code-block syntax highlighting inside the editable surface.
 *
 * Highlighting is a *view* concern: the AST stays one plain-text block and the
 * language lives in its `lang` attribute. These tests pin both halves of that
 * contract — the token spans appear and follow edits, and nothing about the
 * document changes because of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKernelEditor,
  type KernelEditor,
} from '../../../../../src/document/editors/tiptap/editor';
import { pmDocToBlocks } from '../../../../../src/document/editors/tiptap/convert';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

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

function codeBlock(lang: string | null, text: string): BlockNode {
  return block('blk_code', 'codeBlock', lang === null ? {} : { lang }, {
    content: [{ type: 'text', text }],
  });
}

let mounted: { kernel: KernelEditor; element: HTMLElement } | null = null;

afterEach(() => {
  mounted?.kernel.destroy();
  mounted?.element.remove();
  mounted = null;
});

function mount(blocks: BlockNode[]): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  const kernel = createKernelEditor({ element, doc: doc(blocks) });
  mounted = { kernel, element };
  return kernel.editor.view.dom;
}

/** Every highlighted run in the surface as `class:text`. */
function tokenRuns(surface: HTMLElement): string[] {
  return [...surface.querySelectorAll('pre code span')].map(
    (span) => `${span.className}:${span.textContent ?? ''}`,
  );
}

describe('code block syntax highlighting', () => {
  it('paints token spans without touching the frozen DOM shape', () => {
    const surface = mount([codeBlock('ts', 'const a: number = 1;')]);
    const pre = surface.querySelector('pre');
    expect(pre?.getAttribute('data-lang')).toBe('ts');
    expect(pre?.querySelector(':scope > code')?.querySelector('span')).not.toBeNull();
    const runs = tokenRuns(surface);
    expect(runs).toContain('alter-code-keyword:const');
    expect(runs).toContain('alter-code-type:number');
    expect(runs).toContain('alter-code-number:1');
  });

  it('highlights the text, so token runs concatenate back to the source', () => {
    const source = 'function f() {\n  return "x";\n}';
    const surface = mount([codeBlock('ts', source)]);
    const code = surface.querySelector('pre > code');
    expect([...code!.querySelectorAll('span')].map((span) => span.textContent).join('')).not.toBe('');
    expect(code?.textContent).toBe(source);
  });

  it('guesses the language of a block that declares none', () => {
    const surface = mount([codeBlock(null, 'function f() { return 1 }')]);
    expect(tokenRuns(surface)).toContain('alter-code-keyword:function');
  });

  it('keeps a declared but unsupported language plain instead of guessing', () => {
    // `text` says "this is prose"; guessing over the author's declaration would
    // paint a command transcript as JavaScript.
    const surface = mount([codeBlock('text', 'const a = 1; function f() {}')]);
    expect(tokenRuns(surface)).toEqual([]);
  });

  it('leaves prose in a code block unhighlighted', () => {
    const surface = mount([codeBlock(null, '这是一段中文说明文字，不是代码。')]);
    expect(tokenRuns(surface)).toEqual([]);
  });

  it('re-tokenizes the block being edited', () => {
    const surface = mount([codeBlock('ts', 'const a = 1;')]);
    mounted!.kernel.editor.chain().insertContentAt(1, 'let b = 2;\n').run();
    expect(tokenRuns(surface)).toContain('alter-code-keyword:let');
  });

  it('keeps tokens through a selection-only change', () => {
    const surface = mount([codeBlock('ts', 'const a = 1;')]);
    const before = tokenRuns(surface);
    mounted!.kernel.editor.commands.setTextSelection(3);
    expect(tokenRuns(surface)).toEqual(before);
  });

  it('keeps the document AST free of highlighting', () => {
    mount([codeBlock('ts', 'const a = 1;')]);
    const blocks = pmDocToBlocks(mounted!.kernel.capture()).value;
    expect(blocks[0]?.attrs).toEqual({ lang: 'ts' });
    expect(blocks[0]?.content).toEqual([{ type: 'text', text: 'const a = 1;' }]);
  });

  it('reads a pasted `language-*` class into the AST language attribute', () => {
    mount([codeBlock(null, '')]);
    mounted!.kernel.editor.commands.setContent(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
    const blocks = pmDocToBlocks(mounted!.kernel.capture()).value;
    expect(blocks[0]?.attrs).toEqual({ lang: 'ts' });
    expect(tokenRuns(mounted!.kernel.editor.view.dom)).toContain(
      'alter-code-keyword:const',
    );
  });
});
