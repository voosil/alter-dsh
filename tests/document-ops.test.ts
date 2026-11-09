import { describe, expect, it } from 'vitest';
import { applyOperations } from '../host/document/ops.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  MAX_BLOCK_DEPTH,
  type AlterDoc,
  type BlockNode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type MarkdownBlockParser,
  type Operation,
  type OperationContext,
} from '../host/document/types.js';
import {
  createBlockNode,
  plainTextOfBlock,
  validateAlterDoc,
} from '../host/document/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDoc(blocks: BlockNode[], revision = 3): AlterDoc {
  return {
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision,
    blocks,
  };
}

function inlineText(text: string, marks?: Mark[]): InlineNode {
  return marks === undefined || marks.length === 0
    ? { type: 'text', text }
    : { type: 'text', text, marks };
}

function paragraph(id: string, text: string, marks?: Mark[]): BlockNode {
  if (text === '') return createBlockNode(id, 'paragraph');
  return createBlockNode(id, 'paragraph', {
    content: [inlineText(text, marks)],
  });
}

function paragraphWith(id: string, content: InlineNode[]): BlockNode {
  return createBlockNode(id, 'paragraph', { content });
}

function heading(id: string, level: number, text: string): BlockNode {
  return createBlockNode(id, 'heading', {
    attrs: { level },
    content: [inlineText(text)],
  });
}

function container(
  id: string,
  type: string,
  children: BlockNode[],
  attrs: Record<string, JsonValue> = {},
): BlockNode {
  return createBlockNode(id, type, { attrs, children });
}

const stubParser: MarkdownBlockParser = (source, options) => {
  if (source === '[[unsupported]]')
    throw new DocumentError('parse/unsupported', 'stub 不支持的 markdown');
  if (!source.startsWith('MD:'))
    throw new DocumentError('parse/unsupported', `stub 无法解析：${source}`);
  return source
    .slice(3)
    .split('|')
    .map((text) => paragraph(options.createBlockId(), text));
};

interface ContextProbe {
  ctx: OperationContext;
  objectCalls: Array<{
    docId: string;
    blockId: string;
    type: 'mindmap' | 'component';
    payload: JsonValue;
  }>;
}

function makeContext(overrides: Partial<OperationContext> = {}): ContextProbe {
  let blockSequence = 0;
  let objectSequence = 0;
  const objectCalls: ContextProbe['objectCalls'] = [];
  const ctx: OperationContext = {
    docId: 'doc-test',
    nowIso: () => '2026-11-09T12:00:00.000Z',
    createBlockId: () => `blk_gen_${(blockSequence += 1)}`,
    parseMarkdown: stubParser,
    createObject: (input) => {
      objectCalls.push({
        docId: input.docId,
        blockId: input.blockId,
        type: input.type,
        payload: JSON.parse(JSON.stringify(input.payload)) as JsonValue,
      });
      objectSequence += 1;
      return `obj_gen_${objectSequence}`;
    },
    ...overrides,
  };
  return { ctx, objectCalls };
}

function expectDocumentError(run: () => unknown): DocumentError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    return error as DocumentError;
  }
  throw new Error('expected a DocumentError to be thrown');
}

function expectValid(doc: AlterDoc): void {
  expect(() => validateAlterDoc(doc)).not.toThrow();
}

// ---------------------------------------------------------------------------
// insert_blocks / insert_markdown
// ---------------------------------------------------------------------------

describe('insert operations', () => {
  it('inserts at a top-level index and re-issues missing or colliding ids', () => {
    const base = makeDoc([paragraph('blk_a', 'A')]);
    const { ctx } = makeContext();
    const candidateDup = {
      id: 'blk_a',
      type: 'paragraph',
      attrs: {},
      content: [inlineText('dup')],
    } as BlockNode;
    const candidateBlank = {
      id: '',
      type: 'paragraph',
      attrs: {},
      content: [inlineText('blank')],
    } as BlockNode;
    const candidateMissing = {
      type: 'paragraph',
      attrs: {},
      content: [inlineText('missing')],
    } as unknown as BlockNode;

    const result = applyOperations(
      base,
      [
        {
          op: 'insert_blocks',
          index: 0,
          blocks: [candidateDup, candidateBlank, candidateMissing],
        },
      ],
      ctx,
    );

    expect(result.doc.blocks.map((block) => block.id)).toEqual([
      'blk_gen_1',
      'blk_gen_2',
      'blk_gen_3',
      'blk_a',
    ]);
    expect(result.doc.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(result.doc.revision).toBe(3);
    expect(result.diff.applied).toEqual([
      {
        index: 0,
        op: 'insert_blocks',
        changedBlockIds: ['blk_gen_1', 'blk_gen_2', 'blk_gen_3'],
      },
    ]);
    expect(result.diff.changedBlockIds).toEqual([
      'blk_gen_1',
      'blk_gen_2',
      'blk_gen_3',
    ]);
    expect(result.inverseOps).toEqual([
      { op: 'delete_block', target: 'blk_gen_1' },
      { op: 'delete_block', target: 'blk_gen_2' },
      { op: 'delete_block', target: 'blk_gen_3' },
    ]);
    // Input document is never mutated.
    expect(base.blocks).toHaveLength(1);
    expectValid(result.doc);
  });

  it('inserts after an anchor inside a nested container', () => {
    const base = makeDoc([
      container('blk_c', 'callout', [
        paragraph('blk_p1', 'one'),
        paragraph('blk_p2', 'two'),
      ], { tone: 'warn' }),
    ]);
    const { ctx } = makeContext();
    const result = applyOperations(
      base,
      [
        {
          op: 'insert_blocks',
          parent: 'blk_c',
          after: 'blk_p1',
          blocks: [paragraph('blk_mid', 'mid')],
        },
      ],
      ctx,
    );
    const callout = result.doc.blocks[0]!;
    expect(callout.children?.map((child) => child.id)).toEqual([
      'blk_p1',
      'blk_mid',
      'blk_p2',
    ]);
    expect(result.diff.applied[0]!.changedBlockIds).toEqual([
      'blk_mid',
      'blk_c',
    ]);
    expect(result.inverseOps).toEqual([
      { op: 'delete_block', target: 'blk_mid' },
    ]);
  });

  it('appends by default and supports explicit parent: null', () => {
    const base = makeDoc([
      paragraph('blk_a', 'a'),
      paragraph('blk_b', 'b'),
    ]);
    const { ctx } = makeContext();
    const result = applyOperations(
      base,
      [
        { op: 'insert_blocks', blocks: [paragraph('blk_end', 'end')] },
        {
          op: 'insert_blocks',
          parent: null,
          after: 'blk_a',
          blocks: [paragraph('blk_after', 'after')],
        },
      ],
      ctx,
    );
    expect(result.doc.blocks.map((block) => block.id)).toEqual([
      'blk_a',
      'blk_after',
      'blk_b',
      'blk_end',
    ]);
    expect(result.diff.applied[1]!.index).toBe(1);
  });

  it('inserts markdown through the injected parser', () => {
    const base = makeDoc([paragraph('blk_p', 'p')]);
    const { ctx } = makeContext();
    const result = applyOperations(
      base,
      [
        {
          op: 'insert_markdown',
          parent: null,
          index: 1,
          markdown: 'MD:one|two',
        },
      ],
      ctx,
    );
    expect(result.doc.blocks.map((block) => block.id)).toEqual([
      'blk_p',
      'blk_gen_1',
      'blk_gen_2',
    ]);
    expect(
      result.doc.blocks.slice(1).map((block) => plainTextOfBlock(block)),
    ).toEqual(['one', 'two']);
  });

  it('rejects malformed insert requests with stable codes', () => {
    const { ctx } = makeContext();
    const base = makeDoc([
      paragraph('blk_p', 'p'),
      paragraph('blk_p2', 'p2'),
      container('blk_list', 'bulletList', [
        container('blk_item', 'listItem', [paragraph('blk_itemp', 'item')]),
      ]),
      container('blk_c', 'callout', [paragraph('blk_cp', 'c')], {
        tone: 'info',
      }),
    ]);
    const insert = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    expect(insert({ op: 'insert_blocks', blocks: [] }).code).toBe('op/invalid');
    expect(
      insert({ op: 'insert_blocks', blocks: [], markdown: 'MD:x' }).code,
    ).toBe('op/invalid');
    expect(
      insert({ op: 'insert_blocks', markdown: '', blocks: undefined }).code,
    ).toBe('op/invalid');
    expect(
      insert({
        op: 'insert_blocks',
        parent: 'blk_missing',
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('node/not-found');
    expect(
      insert({
        op: 'insert_blocks',
        parent: 'blk_p',
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      insert({
        op: 'insert_blocks',
        after: 'blk_missing',
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('node/not-found');
    expect(
      insert({
        op: 'insert_blocks',
        parent: 'blk_c',
        after: 'blk_p',
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('op/invalid');
    expect(
      insert({
        op: 'insert_blocks',
        index: 99,
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('op/invalid');
    expect(
      insert({
        op: 'insert_blocks',
        index: 0,
        after: 'blk_p',
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('op/invalid');
    expect(
      insert({
        op: 'insert_blocks',
        parent: 'blk_list',
        blocks: [paragraph('blk_new', 'x')],
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      insert({
        op: 'insert_blocks',
        blocks: [
          {
            id: 'blk_bad',
            type: 'nope',
            attrs: {},
          } as unknown as BlockNode,
        ],
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      insert({
        op: 'insert_blocks',
        blocks: [
          {
            id: 'blk_bad',
            type: 'paragraph',
            attrs: { color: 'red' },
          } as unknown as BlockNode,
        ],
      }).code,
    ).toBe('node/schema-invalid');

    const parseError = insert({
      op: 'insert_markdown',
      markdown: '[[unsupported]]',
    });
    expect(parseError.code).toBe('parse/unsupported');
    expect(parseError.issues?.[0]).toMatchObject({ index: 0 });

    expect(
      expectDocumentError(() =>
        applyOperations(
          base,
          [
            {
              op: 'insert_blocks',
              blocks: [paragraph('blk_ok', 'ok')],
            },
            { op: 'insert_markdown', markdown: '[[unsupported]]' },
          ],
          ctx,
        ),
      ).issues?.[0],
    ).toMatchObject({ index: 1, code: 'parse/unsupported' });
  });

  it('enforces the depth budget for inserted subtrees', () => {
    let inner: BlockNode = paragraph('blk_leaf', 'leaf');
    for (let level = 1; level <= MAX_BLOCK_DEPTH - 1; level += 1)
      inner = createBlockNode(`blk_bq_${level}`, 'blockquote', {
        children: [inner],
      });
    const base = makeDoc([inner]);
    const { ctx } = makeContext();
    // Deepest blockquote (`blk_bq_1`) sits at depth 49, its child at depth 50.
    const error = expectDocumentError(() =>
      applyOperations(
        base,
        [
          {
            op: 'insert_blocks',
            parent: 'blk_bq_1',
            blocks: [
              createBlockNode('blk_new_bq', 'blockquote', {
                children: [paragraph('blk_new_p', 'too deep')],
              }),
            ],
          },
        ],
        ctx,
      ),
    );
    expect(error.code).toBe('node/schema-invalid');
  });

  it('rejects documents that become too large', () => {
    const { ctx } = makeContext();
    const error = expectDocumentError(() =>
      applyOperations(
        makeDoc([paragraph('blk_p', 'p')]),
        [
          {
            op: 'insert_blocks',
            blocks: [paragraph('blk_big', 'x'.repeat(600_000))],
          },
        ],
        ctx,
      ),
    );
    expect(error.code).toBe('doc/too-large');
  });
});

// ---------------------------------------------------------------------------
// replace_block
// ---------------------------------------------------------------------------

describe('replace_block', () => {
  it('replaces one block in place through markdown and keeps its id', () => {
    const base = makeDoc([
      paragraph('blk_p', 'old'),
      paragraph('blk_p2', 'keep'),
    ]);
    const { ctx } = makeContext();
    const result = applyOperations(
      base,
      [{ op: 'replace_block', target: 'blk_p', markdown: 'MD:new' }],
      ctx,
    );
    expect(result.doc.blocks[0]!.id).toBe('blk_p');
    expect(plainTextOfBlock(result.doc.blocks[0]!)).toBe('new');
    expect(result.inverseOps).toEqual([
      {
        op: 'replace_block',
        target: 'blk_p',
        blocks: [paragraph('blk_p', 'old')],
      },
    ]);

    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });

  it('rejects malformed replacements with stable codes', () => {
    const base = makeDoc([
      paragraph('blk_p', 'p'),
      heading('blk_h', 1, 'title'),
    ]);
    const { ctx } = makeContext();
    const replace = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    expect(
      replace({ op: 'replace_block', target: 'blk_missing', blocks: [paragraph('blk_x', 'x')] })
        .code,
    ).toBe('node/not-found');
    expect(
      replace({ op: 'replace_block', target: 'blk_p', blocks: [] }).code,
    ).toBe('op/invalid');
    expect(
      replace({
        op: 'replace_block',
        target: 'blk_p',
        blocks: [paragraph('blk_x', 'x'), paragraph('blk_y', 'y')],
      }).code,
    ).toBe('op/invalid');
    expect(
      replace({ op: 'replace_block', target: 'blk_p', markdown: 'MD:a|b' }).code,
    ).toBe('op/invalid');
    expect(
      replace({
        op: 'replace_block',
        target: 'blk_p',
        blocks: [heading('blk_h2', 2, 'h')],
      }).code,
    ).toBe('op/invalid');
    expect(
      replace({
        op: 'replace_block',
        target: 'blk_p',
        blocks: [
          { id: 'blk_x', type: 'nope', attrs: {} } as unknown as BlockNode,
        ],
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      replace({ op: 'replace_block', target: 'blk_p', blocks: [paragraph('blk_x', 'x')], markdown: 'MD:x' })
        .code,
    ).toBe('op/invalid');
  });
});

// ---------------------------------------------------------------------------
// update_text
// ---------------------------------------------------------------------------

describe('update_text', () => {
  it('replaces unique text and inherits the marks at the replacement start', () => {
    const base = makeDoc([
      paragraphWith('blk_p', [
        inlineText('hello '),
        inlineText('world', [{ type: 'bold' }]),
      ]),
    ]);
    const result = applyOperations(
      base,
      [
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'world', newText: 'there' }],
        },
      ],
      makeContext().ctx,
    );
    expect(plainTextOfBlock(result.doc.blocks[0]!)).toBe('hello there');
    expect(result.doc.blocks[0]!.content).toEqual([
      inlineText('hello '),
      inlineText('there', [{ type: 'bold' }]),
    ]);
    expectValid(result.doc);
  });

  it('trims marks at run boundaries and merges equal adjacent runs', () => {
    const base = makeDoc([
      paragraphWith('blk_p', [
        inlineText('ab', [{ type: 'bold' }]),
        inlineText('cd'),
      ]),
    ]);
    const result = applyOperations(
      base,
      [
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'bc', newText: 'X' }],
        },
      ],
      makeContext().ctx,
    );
    expect(result.doc.blocks[0]!.content).toEqual([
      inlineText('aX', [{ type: 'bold' }]),
      inlineText('d'),
    ]);
  });

  it('rejects ambiguous edits unless replaceAll is set', () => {
    const base = makeDoc([
      paragraph('blk_p', 'foo bar foo'),
    ]);
    const { ctx } = makeContext();
    const ambiguous = expectDocumentError(() =>
      applyOperations(
        base,
        [
          {
            op: 'update_text',
            target: 'blk_p',
            edits: [{ oldText: 'foo', newText: 'baz' }],
          },
        ],
        ctx,
      ),
    );
    expect(ambiguous.code).toBe('op/invalid');
    expect(ambiguous.message).toMatch(/歧义/);

    const result = applyOperations(
      base,
      [
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'foo', newText: 'baz', replaceAll: true }],
        },
      ],
      makeContext().ctx,
    );
    expect(plainTextOfBlock(result.doc.blocks[0]!)).toBe('baz bar baz');
  });

  it('reports misses, forbidden targets and invalid edit payloads', () => {
    const base = makeDoc([
      paragraph('blk_p', 'hello'),
      createBlockNode('blk_code', 'codeBlock', {
        attrs: { lang: 'ts' },
        content: [inlineText('const x = 1;')],
      }),
      createBlockNode('blk_divider', 'divider'),
      createBlockNode('blk_empty', 'paragraph'),
    ]);
    const { ctx } = makeContext();
    const update = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    const miss = update({
      op: 'update_text',
      target: 'blk_p',
      edits: [{ oldText: 'absent', newText: 'x' }],
    });
    expect(miss.code).toBe('op/invalid');
    expect(miss.message).toMatch(/未命中/);

    expect(
      update({ op: 'update_text', target: 'blk_missing', edits: [{ oldText: 'a', newText: 'b' }] })
        .code,
    ).toBe('node/not-found');
    expect(
      update({ op: 'update_text', target: 'blk_code', edits: [{ oldText: 'const', newText: 'let' }] })
        .code,
    ).toBe('node/not-writable');
    expect(
      update({ op: 'update_text', target: 'blk_divider', edits: [{ oldText: 'a', newText: 'b' }] })
        .code,
    ).toBe('node/not-writable');
    // Empty block: nothing to match.
    expect(
      update({ op: 'update_text', target: 'blk_empty', edits: [{ oldText: 'a', newText: 'b' }] })
        .code,
    ).toBe('op/invalid');
    expect(
      update({ op: 'update_text', target: 'blk_p', edits: [] }).code,
    ).toBe('op/invalid');
    expect(
      update({ op: 'update_text', target: 'blk_p', edits: [{ oldText: '', newText: 'x' }] })
        .code,
    ).toBe('op/invalid');
  });

  it('edits across hard breaks and can introduce new breaks', () => {
    const base = makeDoc([
      paragraphWith('blk_p', [
        inlineText('a'),
        { type: 'hardBreak' },
        inlineText('b'),
      ]),
    ]);
    const { ctx } = makeContext();
    const withBreak = applyOperations(
      base,
      [
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'a', newText: 'a\nnew' }],
        },
      ],
      ctx,
    );
    expect(plainTextOfBlock(withBreak.doc.blocks[0]!)).toBe('a\nnew\nb');
    expect(withBreak.doc.blocks[0]!.content).toEqual([
      inlineText('a'),
      { type: 'hardBreak' },
      inlineText('new'),
      { type: 'hardBreak' },
      inlineText('b'),
    ]);

    const acrossBreak = applyOperations(
      base,
      [
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'a\nb', newText: 'ab' }],
        },
      ],
      makeContext().ctx,
    );
    expect(acrossBreak.doc.blocks[0]!.content).toEqual([inlineText('ab')]);
  });
});

// ---------------------------------------------------------------------------
// update_attrs
// ---------------------------------------------------------------------------

describe('update_attrs', () => {
  it('patches attributes and deletes optionals with null', () => {
    const base = makeDoc([
      createBlockNode('blk_img', 'image', {
        attrs: { assetId: 'asset_1', alt: '图' },
      }),
    ]);
    const patched = applyOperations(
      base,
      [
        {
          op: 'update_attrs',
          target: 'blk_img',
          attrs: { caption: '说明' },
        },
      ],
      makeContext().ctx,
    );
    expect(patched.doc.blocks[0]!.attrs).toEqual({
      assetId: 'asset_1',
      alt: '图',
      caption: '说明',
    });

    const cleaned = applyOperations(
      patched.doc,
      [{ op: 'update_attrs', target: 'blk_img', attrs: { alt: null } }],
      makeContext().ctx,
    );
    expect(cleaned.doc.blocks[0]!.attrs).toEqual({
      assetId: 'asset_1',
      caption: '说明',
    });
    expectValid(cleaned.doc);
  });

  it('protects required attributes and objectId', () => {
    const base = makeDoc([
      createBlockNode('blk_img', 'image', { attrs: { assetId: 'asset_1' } }),
      createBlockNode('blk_mm', 'mindmap', { attrs: { objectId: 'obj_old' } }),
      createBlockNode('blk_divider', 'divider'),
    ]);
    const { ctx } = makeContext();
    const update = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    expect(
      update({ op: 'update_attrs', target: 'blk_img', attrs: { assetId: null } })
        .code,
    ).toBe('node/schema-invalid');
    expect(
      update({
        op: 'update_attrs',
        target: 'blk_mm',
        attrs: { objectId: 'obj_other' },
      }).code,
    ).toBe('node/not-writable');
    expect(
      update({
        op: 'update_attrs',
        target: 'blk_img',
        attrs: { color: 'red' },
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      update({ op: 'update_attrs', target: 'blk_divider', attrs: { x: 1 } })
        .code,
    ).toBe('node/not-writable');
    expect(
      update({ op: 'update_attrs', target: 'blk_missing', attrs: { x: 1 } })
        .code,
    ).toBe('node/not-found');
  });
});

// ---------------------------------------------------------------------------
// move_block
// ---------------------------------------------------------------------------

describe('move_block', () => {
  const buildBase = (): AlterDoc =>
    makeDoc([
      paragraph('blk_p1', 'one'),
      container('blk_c', 'callout', [paragraph('blk_cp', 'inside')], {
        tone: 'info',
      }),
      paragraph('blk_p2', 'two'),
    ]);

  it('moves a block (with its subtree) into a container', () => {
    const base = buildBase();
    const { ctx } = makeContext();
    const result = applyOperations(
      base,
      [
        {
          op: 'move_block',
          target: 'blk_p2',
          parent: 'blk_c',
          index: 0,
        },
      ],
      ctx,
    );
    expect(result.doc.blocks.map((block) => block.id)).toEqual([
      'blk_p1',
      'blk_c',
    ]);
    expect(result.doc.blocks[1]!.children?.map((child) => child.id)).toEqual([
      'blk_p2',
      'blk_cp',
    ]);
    expect(result.diff.applied[0]!.changedBlockIds).toEqual([
      'blk_p2',
      'blk_c',
    ]);

    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });

  it('rejects moves into itself, its subtree, or incompatible parents', () => {
    const base = makeDoc([
      container('blk_c', 'callout', [
        container('blk_bq', 'blockquote', []),
      ], { tone: 'warn' }),
      container('blk_list', 'bulletList', [
        container('blk_item', 'listItem', [paragraph('blk_itemp', 'x')]),
      ]),
      paragraph('blk_p', 'p'),
    ]);
    const { ctx } = makeContext();
    const move = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    expect(
      move({ op: 'move_block', target: 'blk_c', parent: 'blk_c' }).code,
    ).toBe('op/invalid');
    expect(
      move({ op: 'move_block', target: 'blk_c', parent: 'blk_bq' }).code,
    ).toBe('op/invalid');
    expect(
      move({ op: 'move_block', target: 'blk_p', parent: 'blk_list' }).code,
    ).toBe('node/schema-invalid');
    expect(
      move({ op: 'move_block', target: 'blk_missing', index: 0 }).code,
    ).toBe('node/not-found');
    expect(
      move({ op: 'move_block', target: 'blk_c', after: 'blk_c' }).code,
    ).toBe('op/invalid');
  });
});

// ---------------------------------------------------------------------------
// delete_block
// ---------------------------------------------------------------------------

describe('delete_block', () => {
  it('removes a block and re-inserts it through the inverse', () => {
    const base = makeDoc([
      paragraph('blk_p1', 'one'),
      paragraph('blk_p2', 'two'),
      paragraph('blk_p3', 'three'),
    ]);
    const result = applyOperations(
      base,
      [{ op: 'delete_block', target: 'blk_p2' }],
      makeContext().ctx,
    );
    expect(result.doc.blocks.map((block) => block.id)).toEqual([
      'blk_p1',
      'blk_p3',
    ]);
    expect(result.inverseOps).toEqual([
      {
        op: 'insert_blocks',
        parent: null,
        index: 1,
        blocks: [base.blocks[1]],
      },
    ]);
    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });

  it('unwraps container children in place and can undo it', () => {
    const base = makeDoc([
      container('blk_c', 'callout', [
        paragraph('blk_c1', 'one'),
        paragraph('blk_c2', 'two'),
      ], { tone: 'success' }),
      paragraph('blk_tail', 'tail'),
    ]);
    const result = applyOperations(
      base,
      [{ op: 'delete_block', target: 'blk_c', mode: 'unwrap' }],
      makeContext().ctx,
    );
    expect(result.doc.blocks.map((block) => block.id)).toEqual([
      'blk_c1',
      'blk_c2',
      'blk_tail',
    ]);
    expect(result.inverseOps.map((operation) => operation.op)).toEqual([
      'delete_block',
      'delete_block',
      'insert_blocks',
    ]);
    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });

  it('rejects unwrap on non-containers and illegal child placement', () => {
    const base = makeDoc([
      paragraph('blk_p', 'p'),
      container('blk_list', 'bulletList', [
        container('blk_item', 'listItem', [paragraph('blk_itemp', 'x')]),
      ]),
    ]);
    const { ctx } = makeContext();
    const remove = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    expect(
      remove({ op: 'delete_block', target: 'blk_p', mode: 'unwrap' }).code,
    ).toBe('node/not-writable');
    expect(
      remove({ op: 'delete_block', target: 'blk_item', mode: 'unwrap' }).code,
    ).toBe('node/schema-invalid');
    expect(
      remove({ op: 'delete_block', target: 'blk_missing' }).code,
    ).toBe('node/not-found');
    expect(
      remove({
        op: 'delete_block',
        target: 'blk_p',
        mode: 'bogus' as 'remove',
      }).code,
    ).toBe('op/invalid');
  });
});

// ---------------------------------------------------------------------------
// transform_block
// ---------------------------------------------------------------------------

describe('transform_block', () => {
  it('transforms paragraph→heading keeping content and id, and undoes it', () => {
    const base = makeDoc([paragraph('blk_p', 'title')]);
    const result = applyOperations(
      base,
      [
        {
          op: 'transform_block',
          target: 'blk_p',
          to: 'heading',
          attrs: { level: 2 },
        },
      ],
      makeContext().ctx,
    );
    expect(result.doc.blocks[0]).toEqual(
      heading('blk_p', 2, 'title'),
    );
    expect(result.inverseOps.map((operation) => operation.op)).toEqual([
      'transform_block',
      'replace_block',
    ]);
    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });

  it('enforces the transform whitelist and capability declaration', () => {
    const base = makeDoc([
      paragraph('blk_p', 'p'),
      createBlockNode('blk_mm', 'mindmap', { attrs: { objectId: 'obj_1' } }),
      createBlockNode('blk_divider', 'divider'),
    ]);
    const { ctx } = makeContext();
    const transform = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], ctx));

    expect(
      transform({
        op: 'transform_block',
        target: 'blk_p',
        to: 'heading',
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      transform({
        op: 'transform_block',
        target: 'blk_p',
        to: 'mindmap',
        attrs: { objectId: 'obj_x' },
      }).code,
    ).toBe('node/unsupported-transform');
    expect(
      transform({
        op: 'transform_block',
        target: 'blk_p',
        to: 'nope',
      }).code,
    ).toBe('node/schema-invalid');
    expect(
      transform({
        op: 'transform_block',
        target: 'blk_mm',
        to: 'paragraph',
      }).code,
    ).toBe('node/not-writable');
    expect(
      transform({
        op: 'transform_block',
        target: 'blk_divider',
        to: 'paragraph',
      }).code,
    ).toBe('node/not-writable');
    expect(
      transform({
        op: 'transform_block',
        target: 'blk_missing',
        to: 'paragraph',
      }).code,
    ).toBe('node/not-found');
  });

  it('flattens inline content into codeBlock plain text', () => {
    const base = makeDoc([
      paragraphWith('blk_p', [
        inlineText('a', [{ type: 'bold' }]),
        { type: 'hardBreak' },
        inlineText('b'),
      ]),
    ]);
    const result = applyOperations(
      base,
      [
        {
          op: 'transform_block',
          target: 'blk_p',
          to: 'codeBlock',
          attrs: { lang: 'ts' },
        },
      ],
      makeContext().ctx,
    );
    expect(result.doc.blocks[0]).toEqual(
      createBlockNode('blk_p', 'codeBlock', {
        attrs: { lang: 'ts' },
        content: [inlineText('a\nb')],
      }),
    );
    expect(plainTextOfBlock(result.doc.blocks[0]!)).toBe(
      plainTextOfBlock(base.blocks[0]!),
    );

    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });

  it('keeps the plain text when transforming codeBlock back to paragraph', () => {
    const base = makeDoc([
      createBlockNode('blk_code', 'codeBlock', {
        attrs: { lang: 'ts' },
        content: [inlineText('x\ny')],
      }),
    ]);
    const result = applyOperations(
      base,
      [{ op: 'transform_block', target: 'blk_code', to: 'paragraph' }],
      makeContext().ctx,
    );
    expect(result.doc.blocks[0]).toEqual(
      createBlockNode('blk_code', 'paragraph', {
        content: [inlineText('x\ny')],
      }),
    );
  });

  it('falls back to delete+insert when no reverse transform edge exists', () => {
    const base = makeDoc([heading('blk_h', 1, 'T')]);
    const result = applyOperations(
      base,
      [{ op: 'transform_block', target: 'blk_h', to: 'blockquote' }],
      makeContext().ctx,
    );
    expect(result.doc.blocks[0]!.type).toBe('blockquote');
    expect(result.inverseOps.map((operation) => operation.op)).toEqual([
      'delete_block',
      'insert_blocks',
    ]);
    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks).toEqual(base.blocks);
  });
});

// ---------------------------------------------------------------------------
// update_object
// ---------------------------------------------------------------------------

describe('update_object', () => {
  it('creates a new immutable object and points the block at it', () => {
    const base = makeDoc([
      createBlockNode('blk_mm', 'mindmap', { attrs: { objectId: 'obj_old' } }),
    ]);
    const probe = makeContext();
    const payload: JsonValue = {
      root: { id: 'n1', text: 'root', children: [{ id: 'n2', text: 'child' }] },
    };
    const result = applyOperations(
      base,
      [{ op: 'update_object', target: 'blk_mm', payload }],
      probe.ctx,
    );
    expect(probe.objectCalls).toEqual([
      {
        docId: 'doc-test',
        blockId: 'blk_mm',
        type: 'mindmap',
        payload,
      },
    ]);
    expect(result.doc.blocks[0]!.attrs.objectId).toBe('obj_gen_1');
    expectValid(result.doc);

    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.blocks[0]!.attrs.objectId).toBe('obj_old');
  });

  it('validates payloads before creating objects and rejects other targets', () => {
    const base = makeDoc([
      createBlockNode('blk_mm', 'mindmap', { attrs: { objectId: 'obj_old' } }),
      createBlockNode('blk_comp', 'component', {
        attrs: { objectId: 'obj_comp' },
      }),
      paragraph('blk_p', 'p'),
    ]);
    const probe = makeContext();
    const update = (operation: Operation): DocumentError =>
      expectDocumentError(() => applyOperations(base, [operation], probe.ctx));

    expect(
      update({ op: 'update_object', target: 'blk_mm', payload: { root: {} } })
        .code,
    ).toBe('object/invalid');
    expect(probe.objectCalls).toHaveLength(0);
    expect(
      update({ op: 'update_object', target: 'blk_p', payload: {} }).code,
    ).toBe('node/not-writable');
    const componentResult = applyOperations(
      base,
      [
        {
          op: 'update_object',
          target: 'blk_comp',
          payload: { kind: 'declarative', renderer: 'chart', props: {} },
        },
      ],
      probe.ctx,
    );
    expect(probe.objectCalls).toHaveLength(1);
    expect(probe.objectCalls[0]!.type).toBe('component');
    expect(componentResult.doc.blocks[1]!.attrs.objectId).toBe('obj_gen_1');
  });
});

// ---------------------------------------------------------------------------
// Batch semantics, diff and inverse
// ---------------------------------------------------------------------------

describe('batch semantics', () => {
  it('applies an inverse batch that restores the whole document', () => {
    const initial = makeDoc([
      paragraph('blk_p1', 'Hello world'),
      heading('blk_h1', 2, 'Title'),
      container('blk_callout', 'callout', [paragraph('blk_cp1', 'inside')], {
        tone: 'warn',
      }),
      container('blk_list', 'bulletList', [
        container('blk_item', 'listItem', [paragraph('blk_li', 'item')]),
      ]),
      createBlockNode('blk_mm', 'mindmap', { attrs: { objectId: 'obj_old' } }),
      createBlockNode('blk_dv', 'divider'),
    ]);
    const probe = makeContext();
    const ops: Operation[] = [
      {
        op: 'insert_blocks',
        index: 0,
        blocks: [paragraph('blk_new', 'intro')],
      },
      {
        op: 'insert_markdown',
        parent: 'blk_callout',
        after: 'blk_cp1',
        markdown: 'MD:added',
      },
      {
        op: 'update_text',
        target: 'blk_p1',
        edits: [{ oldText: 'world', newText: 'there' }],
      },
      {
        op: 'update_attrs',
        target: 'blk_h1',
        attrs: { level: 3 },
      },
      {
        op: 'replace_block',
        target: 'blk_cp1',
        blocks: [paragraph('blk_cp1', 'replaced')],
      },
      {
        op: 'move_block',
        target: 'blk_p1',
        parent: 'blk_callout',
        index: 0,
      },
      { op: 'transform_block', target: 'blk_h1', to: 'paragraph' },
      {
        op: 'update_object',
        target: 'blk_mm',
        payload: { root: { id: 'r', text: 'root' } },
      },
      { op: 'delete_block', target: 'blk_dv' },
      { op: 'delete_block', target: 'blk_callout', mode: 'unwrap' },
    ];
    const result = applyOperations(initial, ops, probe.ctx);
    expectValid(result.doc);
    expect(result.doc.revision).toBe(initial.revision);
    expect(result.diff.applied).toHaveLength(ops.length);
    expect(result.diff.applied.map((entry) => entry.op)).toEqual(
      ops.map((operation) => operation.op),
    );

    const undone = applyOperations(result.doc, result.inverseOps, makeContext().ctx);
    expect(undone.doc.revision).toBe(initial.revision);
    expect(undone.doc.blocks).toEqual(initial.blocks);
    expect(undone.doc.format).toBe(ALTER_DOC_FORMAT);
    expect(undone.doc.schemaVersion).toBe(ALTER_DOC_SCHEMA_VERSION);
    expectValid(undone.doc);
  });

  it('deduplicates changedBlockIds across operations', () => {
    const base = makeDoc([paragraph('blk_p', 'ab')]);
    const result = applyOperations(
      base,
      [
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'ab', newText: 'cd' }],
        },
        {
          op: 'update_text',
          target: 'blk_p',
          edits: [{ oldText: 'cd', newText: 'ef' }],
        },
      ],
      makeContext().ctx,
    );
    expect(result.diff.changedBlockIds).toEqual(['blk_p']);
    expect(
      result.diff.applied.map((entry) => entry.changedBlockIds),
    ).toEqual([['blk_p'], ['blk_p']]);
    expect(plainTextOfBlock(result.doc.blocks[0]!)).toBe('ef');
  });

  it('is atomic: a failing operation leaves the input untouched', () => {
    const base = makeDoc([paragraph('blk_p', 'p')]);
    const snapshot = JSON.parse(JSON.stringify(base)) as AlterDoc;
    const error = expectDocumentError(() =>
      applyOperations(
        base,
        [
          {
            op: 'insert_blocks',
            index: 0,
            blocks: [paragraph('blk_new', 'new')],
          },
          {
            op: 'update_text',
            target: 'blk_missing',
            edits: [{ oldText: 'a', newText: 'b' }],
          },
        ],
        makeContext().ctx,
      ),
    );
    expect(error.code).toBe('node/not-found');
    expect(error.issues?.[0]).toMatchObject({ index: 1, code: 'node/not-found' });
    expect(base).toEqual(snapshot);
  });

  it('rejects malformed batches and invalid input documents', () => {
    const base = makeDoc([paragraph('blk_p', 'p')]);
    const { ctx } = makeContext();

    expect(
      expectDocumentError(() => applyOperations(base, [], ctx)).code,
    ).toBe('op/invalid');
    expect(
      expectDocumentError(() =>
        applyOperations(
          base,
          [{ op: 'bogus' } as unknown as Operation],
          ctx,
        ),
      ).code,
    ).toBe('op/invalid');
    expect(
      expectDocumentError(() =>
        applyOperations(
          base,
          [{ op: 'update_text' } as unknown as Operation],
          ctx,
        ),
      ).code,
    ).toBe('op/invalid');

    const duplicateIds = makeDoc([
      paragraph('blk_x', 'a'),
      paragraph('blk_x', 'b'),
    ]);
    expect(
      expectDocumentError(() =>
        applyOperations(
          duplicateIds,
          [{ op: 'delete_block', target: 'blk_x' }],
          ctx,
        ),
      ).code,
    ).toBe('node/schema-invalid');
  });
});
