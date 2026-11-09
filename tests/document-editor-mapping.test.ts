import { describe, expect, it } from 'vitest';
import {
  astToTiptap,
  tiptapToBlocks,
} from '../src/document/editor/mapping';
import {
  DocumentDiffError,
  MAX_DIFF_OPERATIONS,
  computeOperations,
} from '../src/document/editor/operations';
import { applyOperations } from '../host/document/ops.js';
import { validateAlterDoc } from '../host/document/schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  type AlterDoc,
  type BlockNode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type MarkdownBlockParser,
  type Operation,
  type OperationContext,
} from '../host/document/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

function text(value: string, marks?: Mark[]): InlineNode {
  return marks === undefined || marks.length === 0
    ? { type: 'text', text: value }
    : { type: 'text', text: value, marks };
}

function paragraph(id: string, value: string): BlockNode {
  return block(id, 'paragraph', {}, { content: [text(value)] });
}

function heading(id: string, level: number, value: string): BlockNode {
  return block(id, 'heading', { level }, { content: [text(value)] });
}

function makeDoc(blocks: BlockNode[], revision = 3): AlterDoc {
  return {
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision,
    blocks,
  };
}

/** A document covering every v0 node type and mark. */
function richDoc(): AlterDoc {
  const nestedList = block('blk_nested', 'bulletList', {}, {
    children: [
      block('blk_nl1', 'listItem', {}, {
        children: [paragraph('blk_nlp', '嵌套项')],
      }),
    ],
  });
  return makeDoc([
    heading('blk_h1', 1, '鉴权方案'),
    block('blk_para', 'paragraph', {}, {
      content: [
        text('普通 '),
        text('粗斜体', [{ type: 'bold' }, { type: 'italic' }]),
        { type: 'hardBreak' },
        text('下划线', [{ type: 'underline' }]),
        text('删除线', [{ type: 'strike' }]),
        text('高亮', [{ type: 'highlight' }]),
        text('代码', [{ type: 'code' }]),
        text('链接', [
          { type: 'link', attrs: { href: 'https://example.com/docs' } },
        ]),
      ],
    }),
    block('blk_bullet', 'bulletList', {}, {
      children: [
        block('blk_b1', 'listItem', {}, {
          children: [paragraph('blk_bp1', '项目一'), nestedList],
        }),
      ],
    }),
    block('blk_ordered', 'orderedList', { start: 2 }, {
      children: [
        block('blk_o1', 'listItem', {}, {
          children: [paragraph('blk_op1', '第一步')],
        }),
      ],
    }),
    block('blk_tasks', 'taskList', {}, {
      children: [
        block('blk_t1', 'listItem', { checked: true }, {
          children: [paragraph('blk_tp1', '已完成')],
        }),
        block('blk_t2', 'listItem', { checked: false }, {
          children: [paragraph('blk_tp2', '未完成')],
        }),
      ],
    }),
    block('blk_quote', 'blockquote', {}, {
      children: [paragraph('blk_qp', '引用内容')],
    }),
    block('blk_code', 'codeBlock', { lang: 'ts' }, {
      content: [text('const answer = 42;\nconsole.log(answer);')],
    }),
    block('blk_divider', 'divider'),
    block('blk_table', 'table', { headerRows: 1 }, {
      children: [
        block('blk_row1', 'tableRow', {}, {
          children: [
            block('blk_cell11', 'tableCell', {}, { content: [text('列一')] }),
            block('blk_cell12', 'tableCell', {}, { content: [text('列二')] }),
          ],
        }),
        block('blk_row2', 'tableRow', {}, {
          children: [
            block('blk_cell21', 'tableCell', {}, { content: [text('值一')] }),
            block('blk_cell22', 'tableCell', {}, { content: [text('值二')] }),
          ],
        }),
      ],
    }),
    block('blk_callout', 'callout', {
      tone: 'warn',
      title: '注意',
      collapsed: false,
    }, {
      children: [paragraph('blk_cp', '高亮块正文')],
    }),
    block('blk_image', 'image', {
      assetId: 'asset_demo01',
      alt: '架构图',
      caption: '图 1',
      width: '320',
    }),
    block('blk_mindmap', 'mindmap', {
      objectId: 'obj_demo01',
      caption: '目标拆解',
    }),
    block('blk_component', 'component', {
      objectId: 'obj_demo02',
      title: '指标看板',
      description: '展示核心指标',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Host operations fixture (same shape as tests/document-ops.test.ts)
// ---------------------------------------------------------------------------

const stubParser: MarkdownBlockParser = (source, options) => {
  if (!source.startsWith('MD:')) {
    throw new Error(`stub 无法解析：${source}`);
  }
  return source
    .slice(3)
    .split('|')
    .map((value) => paragraph(options.createBlockId(), value));
};

function makeContext(): OperationContext {
  let blockSequence = 0;
  let objectSequence = 0;
  return {
    docId: 'doc-editor-test',
    nowIso: () => '2026-11-09T12:00:00.000Z',
    createBlockId: () => `blk_gen_${(blockSequence += 1)}`,
    parseMarkdown: stubParser,
    createObject: (input) => {
      expect(input.type).toMatch(/^(mindmap|component)$/);
      objectSequence += 1;
      return `obj_gen_${objectSequence}`;
    },
  };
}

/** Apply the client batch through the real Host engine and compare. */
function expectAppliesTo(
  oldDoc: AlterDoc,
  newDoc: AlterDoc,
  ops: Operation[],
): AlterDoc['blocks'] {
  expect(ops.length).toBeGreaterThan(0);
  const result = applyOperations(oldDoc, ops, makeContext());
  expect(result.doc.revision).toBe(oldDoc.revision);
  expect(result.doc.format).toBe(ALTER_DOC_FORMAT);
  expect(result.doc.blocks).toEqual(newDoc.blocks);
  expect(() => validateAlterDoc(result.doc)).not.toThrow();
  return result.doc.blocks;
}

function withBlocks(doc: AlterDoc, blocks: BlockNode[]): AlterDoc {
  return { ...doc, blocks };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// AST → Tiptap → AST round-trip
// ---------------------------------------------------------------------------

describe('astToTiptap / tiptapToBlocks round-trip', () => {
  it('projects the full v0 node set into a Tiptap doc', () => {
    const json = astToTiptap(richDoc());
    expect(json.type).toBe('doc');
    expect(json.content).toHaveLength(richDoc().blocks.length);
    const types = (json.content ?? []).map((node) => node.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'table',
      'alterCallout',
      'alterImage',
      'alterMindmap',
      'alterComponent',
    ]);
    // Every projected block carries its AST id.
    for (const [index, node] of (json.content ?? []).entries()) {
      expect(node.attrs?.blockId).toBe(richDoc().blocks[index]!.id);
    }
  });

  it('round-trips every block, id, attr and mark', () => {
    const source = richDoc();
    const roundTripped = tiptapToBlocks(astToTiptap(source));
    expect(roundTripped).toEqual(source.blocks);
    expect(() => validateAlterDoc(makeDoc(roundTripped))).not.toThrow();
  });

  it('preserves mark order, hard breaks and links', () => {
    const source = richDoc();
    const json = astToTiptap(source);
    const para = (json.content ?? [])[1]!;
    expect(para.content?.some((node) => node.type === 'hardBreak')).toBe(true);
    expect(
      para.content?.some(
        (node) =>
          node.marks?.some(
            (mark) =>
              mark.type === 'link' &&
              mark.attrs?.href === 'https://example.com/docs',
          ) === true,
      ),
    ).toBe(true);
    const back = tiptapToBlocks(json);
    expect(back[1]!.content).toEqual(source.blocks[1]!.content);
  });

  it('preserves list/table/callout/object attributes', () => {
    const back = tiptapToBlocks(astToTiptap(richDoc()));
    const byType = (type: string): BlockNode =>
      back.find((node) => node.type === type)!;
    expect(byType('orderedList').attrs).toEqual({ start: 2 });
    const taskItems = byType('taskList').children ?? [];
    expect(taskItems.map((item) => item.attrs)).toEqual([
      { checked: true },
      { checked: false },
    ]);
    expect(byType('table').attrs).toEqual({ headerRows: 1 });
    expect(byType('callout').attrs).toEqual({
      tone: 'warn',
      title: '注意',
      collapsed: false,
    });
    expect(byType('image').attrs).toEqual({
      assetId: 'asset_demo01',
      alt: '架构图',
      caption: '图 1',
      width: '320',
    });
    expect(byType('mindmap').attrs).toEqual({
      objectId: 'obj_demo01',
      caption: '目标拆解',
    });
    expect(byType('component').attrs).toEqual({
      objectId: 'obj_demo02',
      title: '指标看板',
      description: '展示核心指标',
    });
    expect(byType('codeBlock').attrs).toEqual({ lang: 'ts' });
  });

  it('drops schema-filler wrappers for empty containers', () => {
    // Canonical AST form omits empty `content`/`children` arrays (host parser
    // and `createBlockNode` never write them), so that is the form tested.
    const emptyDoc = makeDoc([
      block('blk_empty_quote', 'blockquote'),
      block('blk_empty_callout', 'callout', { tone: 'info' }),
      block('blk_empty_list', 'bulletList'),
      block('blk_empty_ordered', 'orderedList', { start: 2 }),
      block('blk_empty_callout_item', 'callout', { tone: 'warn' }, {
        children: [paragraph('blk_only_child', '唯一子块')],
      }),
    ]);
    const json = astToTiptap(emptyDoc);
    const back = tiptapToBlocks(json);
    expect(back).toEqual(emptyDoc.blocks);
  });

  it('re-issues missing and duplicate block ids, keeps the first id', () => {
    const duplicated = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'blk_dup' },
          content: [{ type: 'text', text: '第一个' }],
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'blk_dup' },
          content: [{ type: 'text', text: '第二个' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '没有 id' }],
        },
      ],
    };
    const blocks = tiptapToBlocks(duplicated);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.id).toBe('blk_dup');
    expect(blocks[1]!.id).not.toBe('blk_dup');
    expect(blocks[2]!.id).not.toBe('blk_dup');
    expect(blocks[1]!.id).toMatch(/^blk_[0-9a-f]{16,}$/);
    expect(blocks[2]!.id).toMatch(/^blk_[0-9a-f]{16,}$/);
    expect(new Set(blocks.map((item) => item.id)).size).toBe(3);
    expect(() => validateAlterDoc(makeDoc(blocks))).not.toThrow();
  });

  it('degrades unknown nodes to paragraphs instead of throwing', () => {
    const unknown = {
      type: 'doc',
      content: [
        {
          type: 'mysteryBlock',
          attrs: { blockId: 'blk_mystery' },
          content: [{ type: 'text', text: '保留文本' }],
        },
        {
          type: 'mysteryEmpty',
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'blk_after' },
          content: [
            { type: 'text', text: '正文' },
            { type: 'mysteryInline', content: [{ type: 'text', text: '尾' }] },
          ],
        },
      ],
    };
    const blocks = tiptapToBlocks(unknown);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      id: 'blk_mystery',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '保留文本' }],
    });
    expect(blocks[1]!.id).toBe('blk_after');
    // Unknown inline wrappers are flattened and merged into the surrounding
    // text run (canonical inline form), so no text is lost.
    expect(blocks[1]!.content?.[0]).toEqual({ type: 'text', text: '正文尾' });
    expect(() => validateAlterDoc(makeDoc(blocks))).not.toThrow();
  });

  it('degrades objects without a required ref to readable placeholders', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'alterImage', attrs: { blockId: 'blk_i' } },
        { type: 'alterMindmap', attrs: { blockId: 'blk_m' } },
        { type: 'alterComponent', attrs: { blockId: 'blk_c' } },
      ],
    };
    const blocks = tiptapToBlocks(json);
    expect(blocks.map((item) => item.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(JSON.stringify(blocks)).toContain('[图片：缺少资产 id]');
    expect(JSON.stringify(blocks)).toContain('[思维导图：缺少对象 id]');
    expect(JSON.stringify(blocks)).toContain('[交互组件：缺少对象 id]');
  });
});

// ---------------------------------------------------------------------------
// computeOperations → Host applyOperations
// ---------------------------------------------------------------------------

describe('computeOperations (verified with the Host engine)', () => {
  it('returns no operations for identical documents', () => {
    const doc = richDoc();
    expect(computeOperations(doc, clone(doc))).toEqual([]);
    expect(computeOperations(doc, { ...clone(doc), revision: 99 })).toEqual([]);
  });

  it('replaces a changed text block and keeps its id', () => {
    const oldDoc = makeDoc([paragraph('blk_p', '旧文本'), paragraph('blk_q', '不变')]);
    const newDoc = withBlocks(oldDoc, [
      paragraph('blk_p', '新文本'),
      paragraph('blk_q', '不变'),
    ]);
    const ops = computeOperations(oldDoc, newDoc);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('replace_block');
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);
  });

  it('inserts and deletes top-level blocks', () => {
    const oldDoc = makeDoc([paragraph('blk_a', 'A'), paragraph('blk_b', 'B')]);
    const newDoc = withBlocks(oldDoc, [
      paragraph('blk_a', 'A'),
      paragraph('blk_fresh', '新段落'),
    ]);
    const insertOps = computeOperations(oldDoc, newDoc);
    expect(insertOps.some((op) => op.op === 'insert_blocks')).toBe(true);
    expectAppliesTo(oldDoc, newDoc, insertOps);

    const deleteOps = computeOperations(newDoc, oldDoc);
    expect(deleteOps.some((op) => op.op === 'delete_block')).toBe(true);
    expectAppliesTo(newDoc, oldDoc, deleteOps);
  });

  it('moves blocks to match a new top-level order', () => {
    const oldDoc = makeDoc([
      paragraph('blk_a', 'A'),
      paragraph('blk_b', 'B'),
      paragraph('blk_c', 'C'),
    ]);
    const newDoc = withBlocks(oldDoc, [
      paragraph('blk_c', 'C'),
      paragraph('blk_a', 'A'),
      paragraph('blk_b', 'B'),
    ]);
    const ops = computeOperations(oldDoc, newDoc);
    expect(ops.some((op) => op.op === 'move_block')).toBe(true);
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);
  });

  it('updates container attrs in place without touching children', () => {
    const oldDoc = makeDoc([
      block('blk_callout', 'callout', { tone: 'info', title: '提示' }, {
        children: [paragraph('blk_cp', '正文')],
      }),
    ]);
    const newDoc = withBlocks(oldDoc, [
      block('blk_callout', 'callout', { tone: 'danger' }, {
        children: [paragraph('blk_cp', '正文')],
      }),
    ]);
    const ops = computeOperations(oldDoc, newDoc);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      op: 'update_attrs',
      target: 'blk_callout',
      attrs: { title: null, tone: 'danger' },
    });
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);
  });

  it('regenerates a nested change while preserving every block id', () => {
    const oldDoc = makeDoc([
      block('blk_list', 'bulletList', {}, {
        children: [
          block('blk_item', 'listItem', {}, {
            children: [paragraph('blk_item_p', '旧列表项')],
          }),
        ],
      }),
    ]);
    const newDoc = withBlocks(oldDoc, [
      block('blk_list', 'bulletList', {}, {
        children: [
          block('blk_item', 'listItem', {}, {
            children: [paragraph('blk_item_p', '新列表项')],
          }),
        ],
      }),
    ]);
    const ops = computeOperations(oldDoc, newDoc);
    const applied = expectAppliesTo(oldDoc, newDoc, ops);
    expect(applied).toEqual(newDoc.blocks);
    expect(JSON.stringify(ops)).toContain('blk_item_p');
  });

  it('handles type changes (paragraph → heading) with id preservation', () => {
    const oldDoc = makeDoc([paragraph('blk_t', '改成标题')]);
    const newDoc = withBlocks(oldDoc, [heading('blk_t', 2, '改成标题')]);
    const ops = computeOperations(oldDoc, newDoc);
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);
  });

  it('moves a block out of a deleted container and back', () => {
    const oldDoc = makeDoc([
      block('blk_outer', 'callout', { tone: 'warn' }, {
        children: [paragraph('blk_inner', '被拖出的段落')],
      }),
      paragraph('blk_tail', '尾段'),
    ]);
    const newDoc = withBlocks(oldDoc, [
      block('blk_outer', 'callout', { tone: 'warn' }),
      paragraph('blk_inner', '被拖出的段落'),
      paragraph('blk_tail', '尾段'),
    ]);
    const ops = computeOperations(oldDoc, newDoc);
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);

    const backOps = computeOperations(newDoc, oldDoc);
    expect(expectAppliesTo(newDoc, oldDoc, backOps)).toEqual(oldDoc.blocks);
  });

  it('applies a mixed edit on the full document', () => {
    const oldDoc = richDoc();
    const next = clone(oldDoc);
    // 1. edit a leaf paragraph
    next.blocks[1] = block('blk_para', 'paragraph', {}, {
      content: [text('改过的段落')],
    });
    // 2. delete the divider
    next.blocks = next.blocks.filter((item) => item.id !== 'blk_divider');
    // 3. insert a new task list at the front
    next.blocks.unshift(
      block('blk_new_tasks', 'taskList', {}, {
        children: [
          block('blk_new_item', 'listItem', { checked: false }, {
            children: [paragraph('blk_new_item_p', '新增任务')],
          }),
        ],
      }),
    );
    // 4. change callout attrs only
    next.blocks = next.blocks.map((item) =>
      item.id === 'blk_callout'
        ? { ...item, attrs: { tone: 'success', title: '完成' } }
        : item,
    );
    // 5. swap the last two blocks
    const last = next.blocks.length;
    const tail = next.blocks[last - 1]!;
    next.blocks[last - 1] = next.blocks[last - 2]!;
    next.blocks[last - 2] = tail;
    const ops = computeOperations(oldDoc, next);
    expect(ops.length).toBeLessThanOrEqual(MAX_DIFF_OPERATIONS);
    expect(expectAppliesTo(oldDoc, next, ops)).toEqual(next.blocks);
  });

  it('rejects edits that need more operations than the limit', () => {
    const oldBlocks = Array.from({ length: MAX_DIFF_OPERATIONS + 6 }, (_, i) =>
      paragraph(`blk_p${i}`, `旧 ${i}`),
    );
    const newBlocks = oldBlocks.map((item, i) =>
      paragraph(`blk_p${i}`, `新 ${i}`),
    );
    expect(() => computeOperations(makeDoc(oldBlocks), makeDoc(newBlocks))).toThrow(
      DocumentDiffError,
    );
    expect(() => computeOperations(makeDoc(oldBlocks), makeDoc(newBlocks))).toThrow(
      /变更过大/,
    );
    // A custom limit is honoured too.
    expect(() =>
      computeOperations(makeDoc(oldBlocks), makeDoc(newBlocks), 3),
    ).toThrow(/变更过大/);
  });

  it('edits inside a table cell and still preserves nested ids', () => {
    const table = clone(richDoc().blocks.find((item) => item.type === 'table')!);
    const oldDoc = makeDoc([table]);
    const newTable = clone(table);
    newTable.children![1]!.children![0] = block('blk_cell21', 'tableCell', {}, {
      content: [text('改过的单元格')],
    });
    const newDoc = makeDoc([newTable]);
    const ops = computeOperations(oldDoc, newDoc);
    const applied = expectAppliesTo(oldDoc, newDoc, ops);
    expect(applied).toEqual(newDoc.blocks);
    expect(JSON.stringify(applied)).toContain('blk_cell21');
    expect(JSON.stringify(applied)).toContain('blk_row2');
  });

  it('handles copy/paste duplicates produced by the editor', () => {
    const oldDoc = makeDoc([paragraph('blk_orig', '原始段落')]);
    const projected = astToTiptap(oldDoc);
    const source = clone(projected.content![0]!);
    const copied = clone(projected.content![0]!);
    copied.content = [{ type: 'text', text: '复制出来的段落' }];
    const newDoc = makeDoc(
      tiptapToBlocks({
        type: 'doc',
        content: [source, copied],
      }),
    );
    // The pasted copy duplicated the id; the mapping re-issued a fresh one.
    expect(newDoc.blocks).toHaveLength(2);
    expect(newDoc.blocks[0]!.id).toBe('blk_orig');
    expect(newDoc.blocks[1]!.id).not.toBe('blk_orig');
    const ops = computeOperations(oldDoc, newDoc);
    expect(ops.some((op) => op.op === 'insert_blocks')).toBe(true);
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);
  });

  it('produces operations the Host accepts for add/delete/move/attrs/type', () => {
    const oldDoc = makeDoc([
      paragraph('blk_a', 'A'),
      block('blk_list', 'bulletList', {}, {
        children: [
          block('blk_item', 'listItem', {}, {
            children: [paragraph('blk_item_p', '项')],
          }),
        ],
      }),
      block('blk_callout', 'callout', { tone: 'info' }, {
        children: [paragraph('blk_cp', '文')],
      }),
    ]);
    const newDoc = withBlocks(oldDoc, [
      block('blk_callout', 'callout', { tone: 'warn' }, {
        children: [paragraph('blk_cp', '文')],
      }),
      heading('blk_a', 3, 'A'),
      block('blk_fresh', 'blockquote', {}, {
        children: [paragraph('blk_fresh_p', '新引用')],
      }),
    ]);
    const ops = computeOperations(oldDoc, newDoc);
    const kinds = new Set(ops.map((op) => op.op));
    expect(kinds.has('delete_block')).toBe(true);
    expect(kinds.has('insert_blocks')).toBe(true);
    expect(kinds.has('update_attrs')).toBe(true);
    expect(expectAppliesTo(oldDoc, newDoc, ops)).toEqual(newDoc.blocks);
  });
});

// ---------------------------------------------------------------------------
// Tiptap schema validity (no DOM required)
// ---------------------------------------------------------------------------

describe('editor schema', () => {
  it('builds a ProseMirror schema that accepts the mapped document', async () => {
    const { getSchema } = await import('@tiptap/core');
    const { Node } = await import('@tiptap/pm/model');
    const { editorExtensions } = await import('../src/document/editor/schema');
    const schema = getSchema(editorExtensions);
    const json = astToTiptap(richDoc());
    const node = Node.fromJSON(schema, json as Record<string, unknown>);
    expect(node.type.name).toBe('doc');
    expect(node.childCount).toBe(richDoc().blocks.length);
    // Wrapper paragraphs keep empty containers schema-valid.
    const emptyDoc = makeDoc([
      block('blk_empty_quote', 'blockquote'),
      block('blk_empty_callout', 'callout', { tone: 'info' }),
      block('blk_empty_list', 'bulletList'),
    ]);
    const emptyNode = Node.fromJSON(
      schema,
      astToTiptap(emptyDoc) as Record<string, unknown>,
    );
    expect(emptyNode.childCount).toBe(3);
    // A brand-new AST document (no blocks) must also load into the editor.
    const blank = Node.fromJSON(
      schema,
      astToTiptap(makeDoc([])) as Record<string, unknown>,
    );
    expect(blank.childCount).toBe(0);
  });

  it('round-trips the exact JSON ProseMirror emits for the editor', async () => {
    const { getSchema } = await import('@tiptap/core');
    const { Node } = await import('@tiptap/pm/model');
    const { editorExtensions } = await import('../src/document/editor/schema');
    const schema = getSchema(editorExtensions);
    const node = Node.fromJSON(
      schema,
      astToTiptap(richDoc()) as Record<string, unknown>,
    );
    // `editor.getJSON()` is `doc.toJSON()`: null attrs are omitted, defaults
    // materialize and empty containers keep wrapper nodes. The reverse mapping
    // must still reproduce the original blocks.
    const fromProseMirror = node.toJSON() as Parameters<typeof tiptapToBlocks>[0];
    expect(tiptapToBlocks(fromProseMirror)).toEqual(richDoc().blocks);
  });
});
