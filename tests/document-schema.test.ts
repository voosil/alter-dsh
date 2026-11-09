import { describe, expect, it } from 'vitest';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  parseAlterDoc,
  serializeAlterDoc,
  type AlterDoc,
} from '../host/document/types.js';
import {
  canTransform,
  createBlockNode,
  operationAllowedOn,
  validateAlterDoc,
  validateObjectPayload,
} from '../host/document/schema.js';

function doc(blocks: AlterDoc['blocks']): AlterDoc {
  return {
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision: 1,
    blocks,
  };
}

describe('document schema', () => {
  it('accepts a representative v0 document', () => {
    const value = doc([
      createBlockNode('blk_h', 'heading', {
        attrs: { level: 1 },
        content: [{ type: 'text', text: '鉴权方案' }],
      }),
      createBlockNode('blk_p', 'paragraph', {
        content: [
          { type: 'text', text: '先做 ' },
          { type: 'text', text: 'P0', marks: [{ type: 'bold' }] },
        ],
      }),
      createBlockNode('blk_c', 'callout', {
        attrs: { tone: 'warn' },
        children: [
          createBlockNode('blk_cp', 'paragraph', {
            content: [{ type: 'text', text: '待确认' }],
          }),
        ],
      }),
      createBlockNode('blk_i', 'image', {
        attrs: { assetId: 'asset_1', alt: '图' },
      }),
      createBlockNode('blk_m', 'mindmap', { attrs: { objectId: 'obj_1' } }),
    ]);
    expect(() => validateAlterDoc(value)).not.toThrow();
  });

  it('rejects duplicate block ids and unknown node types', () => {
    expect(() =>
      validateAlterDoc(
        doc([
          createBlockNode('blk_1', 'paragraph'),
          createBlockNode('blk_1', 'paragraph'),
        ]),
      ),
    ).toThrow(/重复的 block id/);
    expect(() =>
      validateAlterDoc(doc([{ id: 'blk_2', type: 'mystery', attrs: {} }])),
    ).toThrow(/未知的节点类型/);
  });

  it('enforces attribute rules and enums', () => {
    expect(() =>
      validateAlterDoc(
        doc([
          createBlockNode('blk_h', 'heading', {
            attrs: { level: 9 },
            content: [{ type: 'text', text: 'x' }],
          }),
        ]),
      ),
    ).toThrow(/level/);
    expect(() =>
      validateAlterDoc(
        doc([{ id: 'blk_p', type: 'paragraph', attrs: { color: 'red' } }]),
      ),
    ).toThrow(/不支持属性/);
  });

  it('enforces nesting rules', () => {
    expect(() =>
      validateAlterDoc(
        doc([
          {
            id: 'blk_t',
            type: 'table',
            attrs: { headerRows: 1 },
            children: [createBlockNode('blk_p', 'paragraph')],
          },
        ]),
      ),
    ).toThrow(/table/);
    expect(() =>
      validateAlterDoc(
        doc([
          {
            id: 'blk_l',
            type: 'bulletList',
            attrs: {},
            children: [createBlockNode('blk_p', 'paragraph')],
          },
        ]),
      ),
    ).toThrow(/不允许子节点/);
  });

  it('rejects unsafe link marks', () => {
    expect(() =>
      validateAlterDoc(
        doc([
          createBlockNode('blk_p', 'paragraph', {
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          }),
        ]),
      ),
    ).toThrow(/href/);
  });

  it('parses stored alter-doc content and falls back to legacy html', () => {
    const value = doc([createBlockNode('blk_p', 'paragraph')]);
    expect(parseAlterDoc(serializeAlterDoc(value))).toEqual({
      kind: 'alter-doc',
      doc: value,
    });
    expect(parseAlterDoc('<p>旧文档</p>')).toEqual({
      kind: 'legacy',
      html: '<p>旧文档</p>',
    });
  });

  it('validates object payloads and type capabilities', () => {
    expect(() =>
      validateObjectPayload('mindmap', {
        root: { id: 'n1', text: 'root', children: [{ id: 'n2', text: 'a' }] },
      }),
    ).not.toThrow();
    expect(() => validateObjectPayload('mindmap', { root: {} })).toThrow(
      /mindmap/,
    );
    expect(() =>
      validateObjectPayload('component', {
        kind: 'declarative',
        renderer: 'chart',
        props: { type: 'bar' },
      }),
    ).not.toThrow();
    expect(() =>
      validateObjectPayload('component', {
        kind: 'sandbox',
        renderer: 'chart',
        props: {},
      }),
    ).toThrow(/声明式/);

    expect(operationAllowedOn('paragraph', 'update_text')).toBe(true);
    expect(operationAllowedOn('mindmap', 'update_object')).toBe(true);
    expect(operationAllowedOn('paragraph', 'update_object')).toBe(false);
    expect(canTransform('paragraph', 'heading')).toBe(true);
    expect(canTransform('mindmap', 'paragraph')).toBe(false);
  });
});
