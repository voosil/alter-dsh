/**
 * The client schema manifest must mirror the Host node registry.
 *
 * The Host registry is the single source of truth for node contracts; the
 * browser cannot import it (Node types would leak into the client graph), so
 * `src/document/schema-manifest.ts` repeats the parts a kernel needs. This
 * test makes the repetition safe: any drift in node types, content models,
 * attributes, marks or allowed children fails here instead of surfacing as a
 * missing node in the editor.
 */
import { describe, expect, it } from 'vitest';
import { MARK_TYPES, NODE_TYPES as HOST_NODES } from '../../../host/document/ast/schema';
import {
  MARK_ORDER,
  NODE_MANIFEST,
  nodesByContentModel,
  nodeAllowsMark,
} from '../../../src/document/schema-manifest';
import type { JsonValue } from '../../../src/document/types';

describe('schema manifest mirrors the Host registry', () => {
  it('lists exactly the same node types', () => {
    expect(Object.keys(NODE_MANIFEST).sort()).toEqual(
      Object.keys(HOST_NODES).sort(),
    );
  });

  it('uses the same registry order (display order matters to kernels)', () => {
    expect(Object.keys(NODE_MANIFEST)).toEqual(Object.keys(HOST_NODES));
  });

  it('agrees on every content model', () => {
    for (const [type, host] of Object.entries(HOST_NODES)) {
      expect(NODE_MANIFEST[type]?.contentModel, type).toBe(host.contentModel);
    }
  });

  it('agrees on every attribute rule', () => {
    for (const [type, host] of Object.entries(HOST_NODES)) {
      const manifest = NODE_MANIFEST[type]!;
      expect(Object.keys(manifest.attrs).sort(), `${type} attrs`).toEqual(
        Object.keys(host.attrs).sort(),
      );
      for (const [key, spec] of Object.entries(host.attrs)) {
        const mirrored = manifest.attrs[key]!;
        expect(mirrored.type, `${type}.${key} type`).toBe(spec.type);
        expect(mirrored.required ?? false, `${type}.${key} required`).toBe(
          spec.required ?? false,
        );
        expect(mirrored.maxLength, `${type}.${key} maxLength`).toBe(
          spec.maxLength,
        );
        expect(mirrored.enum, `${type}.${key} enum`).toEqual(spec.enum);
        expect(mirrored.default as JsonValue, `${type}.${key} default`).toEqual(
          spec.default as JsonValue,
        );
      }
    }
  });

  it('agrees on the marks each node allows', () => {
    for (const [type, host] of Object.entries(HOST_NODES)) {
      const expected = host.allowedMarks ?? [];
      expect([...NODE_MANIFEST[type]!.marks], `${type} marks`).toEqual([
        ...expected,
      ]);
    }
  });

  it('agrees on allowed children for container nodes', () => {
    for (const [type, host] of Object.entries(HOST_NODES)) {
      if (host.allowedChildren === undefined) continue;
      expect([...(NODE_MANIFEST[type]!.children ?? [])], `${type} children`).toEqual(
        [...host.allowedChildren],
      );
    }
  });

  it('keeps the canonical mark order and membership', () => {
    expect([...MARK_ORDER]).toEqual([...MARK_TYPES]);
  });

  it('groups node types by content model in registry order', () => {
    const inline = nodesByContentModel('inline').map((entry) => entry.type);
    expect(inline).toEqual([
      'paragraph',
      'heading',
      'codeBlock',
      'tableCell',
    ]);
    const none = nodesByContentModel('none').map((entry) => entry.type);
    expect(none).toEqual([
      'divider',
      'image',
      'file',
      'bookmark',
      'docLink',
      'mindmap',
      'component',
    ]);
    const containers = nodesByContentModel('blocks').map((entry) => entry.type);
    expect(containers).toEqual([
      'bulletList',
      'orderedList',
      'taskList',
      'listItem',
      'blockquote',
      'tableRow',
      'callout',
    ]);
    expect(nodesByContentModel('table').map((entry) => entry.type)).toEqual([
      'table',
    ]);
  });

  it('answers mark permission per node', () => {
    expect(nodeAllowsMark('paragraph', 'bold')).toBe(true);
    expect(nodeAllowsMark('heading', 'link')).toBe(true);
    // Code blocks are plain text; unknown nodes allow nothing.
    expect(nodeAllowsMark('codeBlock', 'bold')).toBe(false);
    expect(nodeAllowsMark('nonexistent', 'bold')).toBe(false);
  });

  it('every container child reference points at a declared node', () => {
    for (const entry of Object.values(NODE_MANIFEST)) {
      for (const child of entry.children ?? []) {
        expect(NODE_MANIFEST[child], `${entry.type} -> ${child}`).toBeDefined();
      }
    }
  });
});