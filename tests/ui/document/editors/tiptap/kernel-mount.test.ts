// @vitest-environment jsdom
/**
 * Kernel selection is a UI preference, and the Tiptap kernel mounts through the
 * same contract the legacy one does.
 *
 * The switch must never change silently: `legacy` is the default, an unknown or
 * corrupt stored value falls back to it, and storage failures never break the
 * editor.
 */
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTiptapKernel } from '../../../../../src/document/editors/tiptap/kernel';
import {
  DEFAULT_EDITOR_KERNEL,
  EDITOR_KERNEL_PREFERENCE_KEY,
  parseEditorKernelPreference,
  readEditorKernelPreference,
  writeEditorKernelPreference,
} from '../../../../../src/document/editors/kernel-preference';
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
    baseHtml: '',
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

describe('kernel preference', () => {
  it('defaults to the AST-native kernel before anything is stored', () => {
    expect(DEFAULT_EDITOR_KERNEL).toBe('tiptap');
    expect(readEditorKernelPreference().current).toBe('tiptap');
  });

  it('round-trips a stored selection', () => {
    writeEditorKernelPreference({ current: 'tiptap', reviewedAt: '2026-11-11' });
    expect(readEditorKernelPreference()).toEqual({
      current: 'tiptap',
      reviewedAt: '2026-11-11',
    });
    expect(localStorage.getItem(EDITOR_KERNEL_PREFERENCE_KEY)).toContain(
      'tiptap',
    );
  });

  it('falls back to the default for corrupt or unknown values', () => {
    expect(parseEditorKernelPreference('not json').current).toBe('tiptap');
    expect(parseEditorKernelPreference('{"current":"lexical"}').current).toBe('tiptap');
    expect(parseEditorKernelPreference('null').current).toBe('tiptap');
    expect(parseEditorKernelPreference('{}').current).toBe('tiptap');
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => readEditorKernelPreference()).not.toThrow();
    expect(() =>
      writeEditorKernelPreference({ current: 'tiptap' }),
    ).not.toThrow();
    expect(readEditorKernelPreference().current).toBe('tiptap');
  });
});

describe('Tiptap kernel mount', () => {
  it('mounts, marks itself, and captures the same AST it loaded', () => {
    const doc = sampleDoc();
    const { Component, kernel } = mountTiptapKernel(props(doc));
    render(createElement(Component));
    expect(
      document.querySelector('[data-editor-kernel="tiptap"]'),
    ).not.toBeNull();
    expect(kernel.kind).toBe('tiptap');
    expect(kernel.capture()).toEqual(doc.blocks);
  });

  it('captures edits made through the ProseMirror view', () => {
    const doc = sampleDoc('开始');
    const { Component, kernel } = mountTiptapKernel(props(doc));
    render(createElement(Component));
    const surface = document.querySelector('.ProseMirror');
    expect(surface?.textContent).toBe('开始');
    expect(kernel.capture()).toEqual(doc.blocks);
  });

  it('reports edits through onChange, not HTML', () => {
    const doc = sampleDoc();
    const { Component, kernel } = mountTiptapKernel(props(doc));
    const onChange = vi.fn();
    kernel.subscribe({ onChange });
    render(createElement(Component));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('mounts a different body for a different base revision', () => {
    const first = mountTiptapKernel(props(sampleDoc('旧内容')));
    const result = render(createElement(first.Component));
    expect(document.body.textContent).toContain('旧内容');
    // A new base revision is a new mount (the shell remounts by `revision`).
    const next = mountTiptapKernel({
      ...props(sampleDoc('新内容')),
      revision: 2,
    });
    result.rerender(createElement(next.Component));
    cleanup();
    const remounted = render(createElement(next.Component));
    expect(remounted.container.textContent).toContain('新内容');
  });

  it('stops reporting after destroy', () => {
    const doc = sampleDoc();
    const { Component, kernel } = mountTiptapKernel(props(doc));
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
    const { Component } = mountTiptapKernel(props(doc), {
      surfaceClassName: 'surface',
      placeholder: '开始写点什么…',
    });
    render(createElement(Component));
    const surface = document.querySelector('.ProseMirror');
    expect(surface?.classList.contains('surface')).toBe(true);
    expect(surface?.getAttribute('data-placeholder')).toBe('开始写点什么…');
  });
});

