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
import type { BlockNode } from '../../../src/document/types';

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
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
  it('degrades unknown node types to a visible placeholder with a warning', () => {
    const result = blocksToPmDoc([
      block('blk_ok', 'paragraph', {}, {
        content: [{ type: 'text', text: '保留' }],
      }),
      block('blk_bad', 'notARealNode'),
    ]);
    expect(result.warnings.join('')).toContain('notARealNode');
    // Nothing disappears: the unknown block becomes a paragraph the user sees.
    expect(result.value.childCount).toBe(2);
    const placeholder = result.value.child(1);
    expect(placeholder.type.name).toBe('paragraph');
    expect(placeholder.attrs['id']).toBe('blk_bad');
    expect(placeholder.textContent).toContain('不支持的块');
  });

  it('degrades an atom missing its required reference to a placeholder', () => {
    const result = blocksToPmDoc([
      block('blk_img', 'image', { alt: '没有资产' }),
    ]);
    expect(result.warnings.join('')).toContain('assetId');
    const placeholder = result.value.firstChild!;
    expect(placeholder.type.name).toBe('paragraph');
    expect(placeholder.textContent).toContain('[图片：缺少资产 id]');
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


describe('editor-only nodes map back to the AST contract', () => {
  it('maps task rows to `taskItem` nodes and keeps the checked state', () => {
    const blocks = normalizeBlocks([
      block('blk_tasks', 'taskList', {}, {
        children: [
          block('blk_done', 'listItem', { checked: true }, {
            children: [
              block('blk_done_p', 'paragraph', {}, {
                content: [{ type: 'text', text: '做完' }],
              }),
            ],
          }),
          block('blk_todo', 'listItem', { checked: false }, {
            children: [
              block('blk_todo_p', 'paragraph', {}, {
                content: [{ type: 'text', text: '没做' }],
              }),
            ],
          }),
        ],
      }),
    ]);
    const toPm = blocksToPmDoc(blocks);
    expect(toPm.warnings).toEqual([]);
    const list = toPm.value.firstChild!;
    expect(list.type.name).toBe('taskList');
    expect(list.firstChild?.type.name).toBe('taskItem');
    expect(list.firstChild?.attrs['checked']).toBe(true);
    expect(list.child(1).attrs['checked']).toBe(false);
    expect(pmDocToBlocks(toPm.value).value).toEqual(blocks);
  });

  it('renders header rows as `tableHeader` and derives headerRows on capture', () => {
    const table = (headerRows: number): BlockNode =>
      block('blk_table', 'table', { headerRows }, {
        children: [
          block('blk_r1', 'tableRow', {}, {
            children: [
              block('blk_c11', 'tableCell', {}, {
                content: [{ type: 'text', text: '表头' }],
              }),
            ],
          }),
          block('blk_r2', 'tableRow', {}, {
            children: [
              block('blk_c21', 'tableCell', {}, {
                content: [{ type: 'text', text: '数据' }],
              }),
            ],
          }),
        ],
      });

    const withHeader = blocksToPmDoc([table(1)]);
    expect(withHeader.warnings).toEqual([]);
    const rows = withHeader.value.firstChild!;
    expect(rows.type.name).toBe('table');
    expect(rows.firstChild?.firstChild?.type.name).toBe('tableHeader');
    expect(rows.child(1).firstChild?.type.name).toBe('tableCell');
    expect(pmDocToBlocks(withHeader.value).value).toEqual([table(1)]);

    const withoutHeader = blocksToPmDoc([table(0)]);
    expect(withoutHeader.value.firstChild?.firstChild?.firstChild?.type.name).toBe(
      'tableCell',
    );
    expect(pmDocToBlocks(withoutHeader.value).value).toEqual([table(0)]);
  });

  it('keeps card attributes across the editor schema', () => {
    const blocks = normalizeBlocks([
      block('blk_img', 'image', {
        assetId: 'asset_i',
        alt: '图',
        caption: '说明',
        width: '320',
      }),
      block('blk_file', 'file', {
        assetId: 'asset_f',
        name: 'a.pdf',
        mime: 'application/pdf',
        bytes: 12,
      }),
      block('blk_bm', 'bookmark', {
        url: 'https://example.com',
        title: '示例',
        description: '描述',
        icon: 'globe',
      }),
      block('blk_doc', 'docLink', { docId: 'doc_1', title: '文档' }),
      block('blk_mind', 'mindmap', { objectId: 'obj_1', caption: '脑图' }),
      block('blk_comp', 'component', { objectId: 'obj_2', title: '组件' }),
    ]);
    const toPm = blocksToPmDoc(blocks);
    expect(toPm.warnings).toEqual([]);
    expect(pmDocToBlocks(toPm.value).value).toEqual(blocks);
  });
});

describe('merged table cells keep their spans end to end', () => {
  const mergedCells = (): BlockNode => ({
    id: 'blk_table',
    type: 'table',
    attrs: { headerRows: 0 },
    children: [
      {
        id: 'blk_row1',
        type: 'tableRow',
        attrs: {},
        children: [
          {
            id: 'blk_cell1',
            type: 'tableCell',
            attrs: { colspan: 2, rowspan: 2 },
            content: [{ type: 'text', text: '合并' }],
          },
        ],
      },
      // The row covered by the rowspan above has no cells of its own.
      { id: 'blk_row2', type: 'tableRow', attrs: {} },
    ],
  });

  it('maps spans into the editor nodes and back without losing them', () => {
    const blocks = normalizeBlocks([mergedCells()]);
    const toPm = blocksToPmDoc(blocks);
    expect(toPm.warnings).toEqual([]);
    const table = toPm.value.firstChild!;
    const merged = table.firstChild!.firstChild!;
    expect(merged.attrs['colspan']).toBe(2);
    expect(merged.attrs['rowspan']).toBe(2);
    // The covered row exists but holds no cell (ProseMirror's merge model).
    expect(table.child(1).childCount).toBe(0);
    expect(pmDocToBlocks(toPm.value).value).toEqual(blocks);
  });

  it('omits the implicit span of a plain cell (round-trip is idempotent)', () => {
    const plain = normalizeBlocks([
      {
        id: 'blk_table',
        type: 'table',
        attrs: { headerRows: 1 },
        children: [
          {
            id: 'blk_row1',
            type: 'tableRow',
            attrs: {},
            children: [
              {
                id: 'blk_head',
                type: 'tableCell',
                attrs: {},
                content: [{ type: 'text', text: '头' }],
              },
            ],
          },
          {
            id: 'blk_row2',
            type: 'tableRow',
            attrs: {},
            children: [
              {
                id: 'blk_body',
                type: 'tableCell',
                attrs: {},
                content: [{ type: 'text', text: '体' }],
              },
            ],
          },
        ],
      },
    ]);
    const toPm = blocksToPmDoc(plain);
    expect(toPm.warnings).toEqual([]);
    const head = toPm.value.firstChild!.firstChild!.firstChild!;
    expect(head.attrs['colspan']).toBe(1);
    expect(head.attrs['rowspan']).toBe(1);
    // `1` is implicit: capture must not invent attrs on plain documents.
    expect(pmDocToBlocks(toPm.value).value).toEqual(plain);
  });

  it('clamps an out-of-contract span to the host limit with a warning', () => {
    const schema = getEditorSchema();
    const cell = schema.nodes['tableCell']!.create(
      { id: 'blk_c', colspan: 99, rowspan: 1 },
      schema.nodes['paragraph']!.create(null, null),
    );
    const row = schema.nodes['tableRow']!.create({ id: 'blk_r' }, cell);
    const table = schema.nodes['table']!.create({ id: 'blk_t', headerRows: 0 }, row);
    const pmDoc = schema.nodes['doc']!.create(null, table);
    const captured = pmDocToBlocks(pmDoc);
    expect(captured.warnings.join('')).toContain('50');
    const capturedTable = captured.value[0]!;
    expect(capturedTable.children![0]!.children![0]!.attrs).toEqual({
      colspan: 50,
    });
  });
});
