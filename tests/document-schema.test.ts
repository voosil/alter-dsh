import { describe, expect, it } from 'vitest';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  parseAlterDoc,
  serializeAlterDoc,
  tryParseAlterDoc,
  type AlterDoc,
} from '../host/document/types.js';
import {
  canTransform,
  createBlockNode,
  operationAllowedOn,
  validateAlterDoc,
  validateObjectPayload,
} from '../host/document/schema.js';
import { projectBlock } from '../host/document/projection.js';

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
      createBlockNode('blk_b', 'bookmark', {
        attrs: { url: 'https://example.com/docs', title: '外部文档' },
      }),
      createBlockNode('blk_d', 'docLink', {
        attrs: { docId: 'doc-1', title: '相关文档' },
      }),
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

  it('enforces link card attribute rules', () => {
    expect(() =>
      validateAlterDoc(doc([createBlockNode('blk_b', 'bookmark')])),
    ).toThrow(/缺少属性 url/);
    expect(() =>
      validateAlterDoc(
        doc([
          createBlockNode('blk_b', 'bookmark', {
            attrs: { url: `https://example.com/${'a'.repeat(2048)}` },
          }),
        ]),
      ),
    ).toThrow(/超过长度上限/);
    expect(() =>
      validateAlterDoc(doc([createBlockNode('blk_d', 'docLink')])),
    ).toThrow(/缺少属性 docId/);
    expect(() =>
      validateAlterDoc(
        doc([
          {
            id: 'blk_b',
            type: 'bookmark',
            attrs: { url: 'https://example.com', icon: 1 },
          },
        ]),
      ),
    ).toThrow(/必须是非空字符串/);
  });

  it('projects link cards to markdown links', () => {
    expect(
      projectBlock(
        createBlockNode('blk_b', 'bookmark', {
          attrs: { url: 'https://example.com/a', title: '示例文档' },
        }),
      ),
    ).toBe('[示例文档](https://example.com/a)');
    expect(
      projectBlock(
        createBlockNode('blk_b', 'bookmark', {
          attrs: { url: 'https://example.com/a(b)', title: '示例 [文档]' },
        }),
      ),
    ).toBe('[示例 \\[文档\\]](<https://example.com/a(b)>)');
    expect(
      projectBlock(
        createBlockNode('blk_b', 'bookmark', {
          attrs: { url: 'https://example.com/a' },
        }),
      ),
    ).toBe('[https://example.com/a](https://example.com/a)');
    expect(
      projectBlock(
        createBlockNode('blk_d', 'docLink', {
          attrs: { docId: 'doc-1', title: '相关文档' },
        }),
      ),
    ).toBe('[相关文档](space-doc:doc-1)');
    expect(
      projectBlock(
        createBlockNode('blk_d', 'docLink', { attrs: { docId: 'doc-1' } }),
      ),
    ).toBe('[doc-1](space-doc:doc-1)');
    expect(operationAllowedOn('bookmark', 'update_attrs')).toBe(true);
    expect(operationAllowedOn('docLink', 'update_attrs')).toBe(true);
    expect(operationAllowedOn('bookmark', 'update_text')).toBe(false);
    expect(operationAllowedOn('docLink', 'update_text')).toBe(false);
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

  it('strict-parses stored alter-doc content and rejects anything else', () => {
    const value = doc([createBlockNode('blk_p', 'paragraph')]);
    expect(parseAlterDoc(serializeAlterDoc(value))).toEqual(value);
    expect(tryParseAlterDoc(serializeAlterDoc(value))).toEqual(value);
    for (const invalid of [
      '<p>旧文档</p>',
      '',
      '{"format":"alter-doc/1"}',
      '{"format":"other","schemaVersion":1,"revision":1,"blocks":[]}',
    ]) {
      expect(() => parseAlterDoc(invalid)).toThrow(DocumentError);
      expect(() => parseAlterDoc(invalid)).toThrow('文档内容不是合法的 alter-doc/1');
      expect(tryParseAlterDoc(invalid)).toBeUndefined();
    }
    try {
      parseAlterDoc('<p>旧文档</p>');
    } catch (error) {
      expect((error as DocumentError).code).toBe('doc/schema-invalid');
    }
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
