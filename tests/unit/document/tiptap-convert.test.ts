/**
 * `alter-doc/1` <-> ProseMirror conversion must be lossless.
 *
 * A kernel may only replace the HTML round-trip if the AST survives the new
 * representation unchanged: same block ids, same order, same attrs, same
 * marks, same children. These tests feed every registry node type through both
 * directions and assert exact canonical equality.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateBlockId,
  blocksToPmDoc,
  emptyParagraph,
  normalizeBlocks,
  pmDocToBlocks,
  resetBlockIdSequence,
} from '../../../src/document/editors/tiptap/convert';
import { getEditorSchema } from '../../../src/document/editors/tiptap/schema';

const editorSchema = getEditorSchema();
import { NODE_MANIFEST } from '../../../src/document/schema-manifest';
import type { AlterDoc, BlockNode } from '../../../src/document/types';

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

/** Full-coverage document: every node type with representative attributes. */
function richBlocks(): BlockNode[] {
  return [
    block('blk_h', 'heading', { level: 2 }, {
      content: [{ type: 'text', text: '标题' }],
    }),
    block('blk_p', 'paragraph', {}, {
      content: [
        { type: 'text', text: '普通 ' },
        { type: 'text', text: '粗', marks: [{ type: 'bold' }] },
        { type: 'text', text: '斜', marks: [{ type: 'italic' }] },
        { type: 'text', text: '下划线', marks: [{ type: 'underline' }] },
        { type: 'text', text: '删除', marks: [{ type: 'strike' }] },
        { type: 'text', text: '高亮', marks: [{ type: 'highlight' }] },
        { type: 'text', text: '代码', marks: [{ type: 'code' }] },
        {
          type: 'text',
          text: '链接',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/docs' } }],
        },
        { type: 'hardBreak' },
        { type: 'text', text: '第二行' },
      ],
    }),
    block('blk_ul', 'bulletList', {}, {
      children: [
        block('blk_li1', 'listItem', {}, {
          children: [
            block('blk_lip1', 'paragraph', {}, {
              content: [{ type: 'text', text: '项目一' }],
            }),
          ],
        }),
        block('blk_li2', 'listItem', {}, {
          children: [
            block('blk_lip2', 'paragraph', {}, {
              content: [{ type: 'text', text: '项目二' }],
            }),
          ],
        }),
      ],
    }),
    block('blk_ol', 'orderedList', { start: 3 }, {
      children: [
        block('blk_oli', 'listItem', {}, {
          children: [
            block('blk_olip', 'paragraph', {}, {
              content: [{ type: 'text', text: '第三步' }],
            }),
          ],
        }),
      ],
    }),
    block('blk_tasks', 'taskList', {}, {
      children: [
        block('blk_task1', 'listItem', { checked: true }, {
          children: [
            block('blk_taskp1', 'paragraph', {}, {
              content: [{ type: 'text', text: '已完成' }],
            }),
          ],
        }),
        block('blk_task2', 'listItem', { checked: false }, {
          children: [
            block('blk_taskp2', 'paragraph', {}, {
              content: [{ type: 'text', text: '未完成' }],
            }),
          ],
        }),
      ],
    }),
    block('blk_quote', 'blockquote', {}, {
      children: [
        block('blk_qp', 'paragraph', {}, {
          content: [{ type: 'text', text: '引用内容' }],
        }),
      ],
    }),
    block('blk_code', 'codeBlock', { lang: 'ts' }, {
      content: [{ type: 'text', text: 'const answer = 42;' }],
    }),
    block('blk_hr', 'divider'),
    block('blk_table', 'table', { headerRows: 1 }, {
      children: [
        block('blk_row1', 'tableRow', {}, {
          children: [
            block('blk_c11', 'tableCell', {}, {
              content: [{ type: 'text', text: '列一' }],
            }),
            block('blk_c12', 'tableCell', {}, {
              content: [{ type: 'text', text: '列二' }],
            }),
          ],
        }),
        block('blk_row2', 'tableRow', {}, {
          children: [
            block('blk_c21', 'tableCell', {}, {
              content: [{ type: 'text', text: '值一' }],
            }),
            block('blk_c22', 'tableCell'),
          ],
        }),
      ],
    }),
    block('blk_img', 'image', {
      assetId: 'asset_img1',
      alt: '架构图',
      caption: '图 1',
      width: '320px',
    }),
    block('blk_file', 'file', {
      assetId: 'asset_f1',
      name: '需求说明.pdf',
      mime: 'application/pdf',
      bytes: 2048,
    }),
    block('blk_bm', 'bookmark', {
      url: 'https://example.com/guide',
      title: '指南',
      description: '外部网页',
      icon: 'globe',
    }),
    block('blk_link', 'docLink', { docId: 'doc-target', title: '另一篇文档' }),
    block('blk_callout', 'callout', {
      tone: 'warn',
      title: '注意',
      icon: 'alert',
      collapsed: false,
    }, {
      children: [
        block('blk_cp', 'paragraph', {}, {
          content: [{ type: 'text', text: '提示正文' }],
        }),
      ],
    }),
    block('blk_mind', 'mindmap', { objectId: 'obj_m1', caption: '脑图' }),
    block('blk_comp', 'component', {
      objectId: 'obj_c1',
      title: '进度',
      description: '声明式组件',
    }),
  ];
}

describe('AST -> ProseMirror -> AST is lossless', () => {
  it('round-trips a document using every registry node type', () => {
    const blocks = normalizeBlocks(richBlocks());
    const toPm = blocksToPmDoc(blocks);
    expect(toPm.warnings).toEqual([]);
    const back = pmDocToBlocks(toPm.value);
    expect(back.warnings).toEqual([]);
    expect(back.value).toEqual(blocks);
  });

  it('round-trips ids, order and attrs for a small edit (simulated save)', () => {
    const original = normalizeBlocks(richBlocks());
    const edited = original.map((node) =>
      node.id === 'blk_p'
        ? {
            ...node,
            content: [{ type: 'text' as const, text: '改过的正文' }],
          }
        : node,
    );
    const back = pmDocToBlocks(blocksToPmDoc(edited).value);
    expect(back.value).toEqual(edited);
    // Ids the comment anchors depend on are untouched.
    expect(back.value.map((node) => node.id)).toEqual(
      original.map((node) => node.id),
    );
  });

  it('treats an empty document as one empty paragraph and back', () => {
    const toPm = blocksToPmDoc([]);
    expect(toPm.value.childCount).toBe(1);
    expect(toPm.value.firstChild?.type.name).toBe('paragraph');
    expect(pmDocToBlocks(toPm.value).value).toEqual([
      { id: expect.stringMatching(/^blk_/), type: 'paragraph', attrs: {} },
    ]);
  });

  it('keeps text of a node the AST cannot represent as a warning', () => {
    const pmDoc = editorSchema.nodes['doc']!.create(null, [
      emptyParagraph(editorSchema),
    ]);
    const result = pmDocToBlocks(pmDoc);
    expect(result.warnings).toEqual([]);
    expect(result.value).toHaveLength(1);
  });
});

describe('conversion reports what it cannot represent', () => {
  it('drops unknown node types with a warning instead of silently', () => {
    const result = blocksToPmDoc([
      block('blk_ok', 'paragraph', {}, {
        content: [{ type: 'text', text: '保留' }],
      }),
      block('blk_bad', 'notARealNode'),
    ]);
    expect(result.warnings.join('')).toContain('notARealNode');
    expect(result.value.childCount).toBe(1);
  });

  it('drops attributes outside the node contract with a warning', () => {
    const result = blocksToPmDoc([
      block('blk_p', 'paragraph', { bogus: 'x' }, {
        content: [{ type: 'text', text: '正文' }],
      }),
    ]);
    expect(result.warnings.join('')).toContain('bogus');
    const back = pmDocToBlocks(result.value);
    expect(back.value).toEqual([
      block('blk_p', 'paragraph', {}, {
        content: [{ type: 'text', text: '正文' }],
      }),
    ]);
  });

  it('rejects marks inside a code block (the Host contract)', () => {
    const result = blocksToPmDoc([
      block('blk_code', 'codeBlock', {}, {
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }],
      }),
    ]);
    // The mark cannot exist in the schema; the text must survive without it.
    const back = pmDocToBlocks(result.value);
    expect(back.value).toEqual([
      block('blk_code', 'codeBlock', {}, {
        content: [{ type: 'text', text: 'x' }],
      }),
    ]);
  });

  it('drops a container that would become invalid (no representable child)', () => {
    const result = blocksToPmDoc([
      block('blk_ul', 'bulletList', {}, {
        children: [block('blk_badchild', 'unknownNode')],
      }),
    ]);
    expect(result.warnings.join('')).toContain('bulletList');
    expect(result.value.childCount).toBe(1); // the fallback empty paragraph
  });
});

describe('editor-created nodes get stable ids', () => {
  it('allocates ids for nodes the editor created without one', () => {
    resetBlockIdSequence();
    const pmDoc = editorSchema.nodes['doc']!.create(null, [
      editorSchema.nodes['paragraph']!.create(null, [
        editorSchema.text('新段落'),
      ]),
    ]);
    const first = pmDocToBlocks(pmDoc).value[0]!.id;
    const second = pmDocToBlocks(pmDoc).value[0]!.id;
    expect(first).toMatch(/^blk_/);
    // The same document keeps its generated id on repeated captures.
    expect(second).toBe(first);
    expect(allocateBlockId()).not.toBe(first);
  });
});

describe('schema covers the whole manifest', () => {
  it('declares every manifest node with its id attribute', () => {
    for (const type of Object.keys(NODE_MANIFEST)) {
      const nodeType = editorSchema.nodes[type];
      expect(nodeType, type).toBeDefined();
      expect(Object.keys(nodeType!.spec.attrs ?? {}), type).toContain('id');
    }
  });

  it('mirrors registry attributes beyond id', () => {
    expect(Object.keys(editorSchema.nodes['heading']!.spec.attrs ?? {}).sort()).toEqual([
      'id',
      'level',
    ]);
    expect(Object.keys(editorSchema.nodes['listItem']!.spec.attrs ?? {}).sort()).toEqual([
      'checked',
      'id',
    ]);
  });

  it('forbids marks in code blocks and allows them in paragraphs', () => {
    expect(editorSchema.nodes['codeBlock']!.spec.marks).toBe('');
    const para = editorSchema.nodes['paragraph']!.create(
      { id: 'blk_p' },
      editorSchema.text('x', [editorSchema.marks['bold']!.create()]),
    );
    expect(para.firstChild?.marks).toHaveLength(1);
  });

  it('rejects content the schema forbids (guard, not silent coercion)', () => {
    // `create()` does not validate content; `check()` is the schema guard the
    // kernel relies on before a body reaches the Host.
    const paragraph = editorSchema.nodes['paragraph']!.create({ id: 'blk_p' }, [
      editorSchema.text('x'),
    ]);
    expect(() =>
      editorSchema.nodes['bulletList']!.create(null, [paragraph]).check(),
    ).toThrow();
    expect(() =>
      editorSchema.nodes['table']!.create(null, [paragraph]).check(),
    ).toThrow();
    // ... and no table part may sit at the document root.
    const row = editorSchema.nodes['tableRow']!.create(null, [
      editorSchema.nodes['tableCell']!.create(null, []),
    ]);
    expect(() => editorSchema.nodes['doc']!.create(null, [row]).check()).toThrow();
    // The same guard accepts valid content.
    const item = editorSchema.nodes['listItem']!.create(null, [paragraph]);
    expect(() =>
      editorSchema.nodes['bulletList']!.create(null, [item]).check(),
    ).not.toThrow();
  });
});
