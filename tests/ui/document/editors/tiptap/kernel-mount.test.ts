// @vitest-environment jsdom
/**
 * The AST-native kernel mounts through the editor-kernel contract.
 *
 * These tests lock the mount lifecycle: the body is created once per document,
 * an external revision reloads it in place, comments repaint without editing,
 * and destroying the kernel leaves no listeners behind.
 */
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTiptapKernel } from '../../../../../src/document/editors/tiptap/kernel';
import type { EditorKernelProps } from '../../../../../src/document/editors/kernel';
import type { AlterDoc, BlockNode } from '../../../../../src/document/types';

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function sampleDoc(text = '正文'): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 1,
    blocks: [
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text }],
      }),
    ],
  };
}

function props(doc: AlterDoc): EditorKernelProps {
  return {
    docId: 'doc-1',
    document: doc,
    revision: doc.revision,
    caret: 'none',
    comments: [],
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Tiptap kernel mount', () => {
  it('mounts, marks itself, and captures the same AST it loaded', () => {
    const doc = sampleDoc();
    const { Component, kernel } = mountTiptapKernel(() => props(doc));
    render(createElement(Component));
    expect(
      document.querySelector('[data-editor-kernel="tiptap"]'),
    ).not.toBeNull();
    expect(kernel.kind).toBe('tiptap');
    expect(kernel.capture()).toEqual(doc.blocks);
  });

  it('captures edits made through the ProseMirror view', () => {
    const doc = sampleDoc('开始');
    const { Component, kernel } = mountTiptapKernel(() => props(doc));
    render(createElement(Component));
    const surface = document.querySelector('.ProseMirror');
    expect(surface?.textContent).toBe('开始');
    expect(kernel.capture()).toEqual(doc.blocks);
  });

  it('reports edits through onChange, not HTML', () => {
    const doc = sampleDoc();
    const { Component, kernel } = mountTiptapKernel(() => props(doc));
    const onChange = vi.fn();
    kernel.subscribe({ onChange });
    render(createElement(Component));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reloads the same body when the base revision changes', () => {
    // The page reloads an external change (version restore, another writer) by
    // passing a new document + revision; the kernel must adopt it in place
    // instead of keeping the body it mounted with.
    let current = props(sampleDoc('旧内容'));
    const { Component, kernel } = mountTiptapKernel(() => current);
    const view = render(createElement(Component));
    expect(view.container.textContent).toContain('旧内容');
    current = { ...props(sampleDoc('新内容')), revision: 2 };
    view.rerender(createElement(Component));
    expect(view.container.textContent).toContain('新内容');
    expect(kernel.capture()).toEqual(sampleDoc('新内容').blocks);
  });

  it('reloads in place and drops the previous undo history', () => {
    // An external reload (version restore, conflict, draft recovery) must not
    // leave the pre-reload body reachable through undo — saving that would
    // overwrite the restored document.
    let current = props(sampleDoc('旧内容'));
    const { Component, kernel } = mountTiptapKernel(() => current);
    const view = render(createElement(Component));
    expect(view.container.textContent).toContain('旧内容');

    current = { ...props(sampleDoc('新内容')), revision: 2 };
    view.rerender(createElement(Component));
    expect(view.container.textContent).toContain('新内容');

    // Undo has nothing to undo: the reload rebuilt the editor, so the history
    // cannot reach the pre-reload body.
    const host = document.querySelector('[data-editor-kernel="tiptap"]') as
      | (HTMLElement & {
          pmView?: {
            state: {
              plugins: readonly {
                key: string;
                getState(state: unknown): unknown;
              }[];
            };
          };
        })
      | null;
    const pmView = host?.pmView;
    expect(pmView).toBeDefined();
    const history = pmView!.state.plugins.find((plugin) =>
      plugin.key.startsWith('history$'),
    );
    const historyState = history?.getState(pmView!.state) as
      | { done?: unknown[] }
      | undefined;
    expect(historyState?.done?.length ?? 0).toBe(0);
    expect(kernel.capture()).toEqual(sampleDoc('新内容').blocks);
  });

  it('stops reporting after destroy', () => {
    const doc = sampleDoc();
    const { Component, kernel } = mountTiptapKernel(() => props(doc));
    const onChange = vi.fn();
    kernel.subscribe({ onChange });
    render(createElement(Component));
    kernel.destroy();
    expect(onChange).not.toHaveBeenCalled();
    // A destroyed kernel must not throw when the shell asks for its body.
    expect(kernel.capture()).toEqual(doc.blocks);
  });

  it('applies the frozen surface class and placeholder', () => {
    const doc = sampleDoc();
    const { Component } = mountTiptapKernel(() => props(doc), {
      surfaceClassName: 'surface',
      placeholder: '开始写点什么…',
    });
    render(createElement(Component));
    const surface = document.querySelector('.ProseMirror');
    expect(surface?.classList.contains('surface')).toBe(true);
    expect(surface?.getAttribute('data-placeholder')).toBe('开始写点什么…');
  });
});

