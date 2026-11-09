import { describe, expect, it } from 'vitest';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  type AlterDoc,
  type BlockNode,
} from '../host/document/types.js';
import {
  createBlockNode,
  validateAlterDoc,
} from '../host/document/schema.js';
import {
  inlineToMarkdown,
  projectBlock,
  projectDocument,
} from '../host/document/projection.js';
import { parseMarkdownBlocks } from '../host/document/markdown.js';

function doc(blocks: BlockNode[], revision = 1): AlterDoc {
  return {
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision,
    blocks,
  };
}

/** Deterministic block ids for parser tests. */
function idGenerator(): () => string {
  let index = 0;
  return () => `blk_g${++index}`;
}

function parse(source: string, options: { hasAsset?: (id: string) => boolean } = {}): BlockNode[] {
  return parseMarkdownBlocks(source, {
    createBlockId: idGenerator(),
    ...options,
  });
}

function expectDocumentError(fn: () => unknown, code: string): DocumentError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    const documentError = error as DocumentError;
    expect(documentError.code).toBe(code);
    return documentError;
  }
  throw new Error('expected a DocumentError to be thrown');
}

/** Parse → project (no anchors); the result ends with one newline. */
function roundTrip(source: string, options: { hasAsset?: (id: string) => boolean } = {}): string {
  const blocks = parse(source, options);
  validateAlterDoc(doc(blocks));
  return projectDocument(doc(blocks), { anchors: false }).markdown;
}

describe('projectDocument golden', () => {
  const blocks: BlockNode[] = [
    createBlockNode('blk_b1', 'heading', {
      attrs: { level: 1 },
      content: [{ type: 'text', text: '文档标题' }],
    }),
    createBlockNode('blk_b2', 'paragraph', {
      content: [
        { type: 'text', text: '普通段落，含 ' },
        { type: 'text', text: '重点', marks: [{ type: 'bold' }] },
        { type: 'text', text: '。' },
      ],
    }),
    createBlockNode('blk_b3', 'bulletList', {
      children: [
        createBlockNode('blk_b3a', 'listItem', {
          children: [
            createBlockNode('blk_b3a1', 'paragraph', {
              content: [{ type: 'text', text: '第一项' }],
            }),
          ],
        }),
        createBlockNode('blk_b3b', 'listItem', {
          children: [
            createBlockNode('blk_b3b1', 'paragraph', {
              content: [{ type: 'text', text: '第二项' }],
            }),
            createBlockNode('blk_b3b2', 'bulletList', {
              children: [
                createBlockNode('blk_b3b2a', 'listItem', {
                  children: [
                    createBlockNode('blk_b3b2a1', 'paragraph', {
                      content: [{ type: 'text', text: '嵌套' }],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    createBlockNode('blk_b4', 'blockquote', {
      children: [
        createBlockNode('blk_b4a', 'paragraph', {
          content: [{ type: 'text', text: '引用内容' }],
        }),
      ],
    }),
    createBlockNode('blk_b5', 'codeBlock', {
      attrs: { lang: 'ts' },
      content: [{ type: 'text', text: 'const a = 1;' }],
    }),
    createBlockNode('blk_b6', 'divider'),
    createBlockNode('blk_b7', 'table', {
      attrs: { headerRows: 1 },
      children: [
        createBlockNode('blk_b7a', 'tableRow', {
          children: [
            createBlockNode('blk_b7a1', 'tableCell', {
              content: [{ type: 'text', text: '名称' }],
            }),
            createBlockNode('blk_b7a2', 'tableCell', {
              content: [{ type: 'text', text: '数量' }],
            }),
          ],
        }),
        createBlockNode('blk_b7b', 'tableRow', {
          children: [
            createBlockNode('blk_b7b1', 'tableCell', {
              content: [{ type: 'text', text: '苹果' }],
            }),
            createBlockNode('blk_b7b2', 'tableCell', {
              content: [{ type: 'text', text: '3' }],
            }),
          ],
        }),
      ],
    }),
    createBlockNode('blk_b8', 'image', {
      attrs: { assetId: 'asset_1', alt: '图' },
    }),
    createBlockNode('blk_b9', 'callout', {
      attrs: { tone: 'warn', title: '注意', collapsed: true },
      children: [
        createBlockNode('blk_b9a', 'paragraph', {
          content: [{ type: 'text', text: '别删库' }],
        }),
      ],
    }),
    createBlockNode('blk_b10', 'mindmap', {
      attrs: { objectId: 'obj_1', caption: '脑图' },
    }),
    createBlockNode('blk_b11', 'component', {
      attrs: { objectId: 'obj_2', title: '图表' },
    }),
    { id: 'blk_b12', type: 'mystery', attrs: {} },
  ];

  const withoutAnchors = [
    '# 文档标题',
    '',
    '普通段落，含 **重点**。',
    '',
    '- 第一项',
    '- 第二项',
    '  - 嵌套',
    '',
    '> 引用内容',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '---',
    '',
    '| 名称 | 数量 |',
    '| --- | --- |',
    '| 苹果 | 3 |',
    '',
    '![图](space-asset://asset_1)',
    '',
    ':::callout{tone="warn" title="注意" collapsed=true}',
    '别删库',
    ':::',
    '',
    ':::mindmap{objectId="obj_1" caption="脑图"}',
    ':::',
    '',
    ':::component{objectId="obj_2" title="图表"}',
    ':::',
    '',
    ':::opaque{type="mystery"}',
    '[unsupported node]',
    ':::',
  ].join('\n');

  it('projects every v0 node type with stable formatting', () => {
    const result = projectDocument(doc(blocks), { anchors: false });
    expect(result.markdown).toBe(`${withoutAnchors}\n`);
    expect(result.truncated).toBe(false);
    expect(result.includedBlocks).toEqual(blocks.map((block) => ({ id: block.id, type: block.type })));
  });

  it('prepends block anchor comments by default', () => {
    const result = projectDocument(doc(blocks));
    const lines = result.markdown.split('\n');
    expect(lines[0]).toBe('<!-- blk:blk_b1 -->');
    expect(lines[1]).toBe('# 文档标题');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('<!-- blk:blk_b2 -->');
    expect(result.markdown).toContain('<!-- blk:blk_b9 -->\n:::callout');
    expect(result.markdown.endsWith(':::')).toBe(false);
    expect(result.markdown.endsWith(':::\n')).toBe(true);
    expect(result.markdown.trimEnd().split('\n').length).toBe(
      withoutAnchors.split('\n').length + blocks.length,
    );
  });

  it('matches the anchors golden exactly', () => {
    const expected = [
      '<!-- blk:blk_b1 -->',
      '# 文档标题',
      '',
      '<!-- blk:blk_b2 -->',
      '普通段落，含 **重点**。',
      '',
      '<!-- blk:blk_b3 -->',
      '- 第一项',
      '- 第二项',
      '  - 嵌套',
      '',
      '<!-- blk:blk_b4 -->',
      '> 引用内容',
      '',
      '<!-- blk:blk_b5 -->',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '<!-- blk:blk_b6 -->',
      '---',
      '',
      '<!-- blk:blk_b7 -->',
      '| 名称 | 数量 |',
      '| --- | --- |',
      '| 苹果 | 3 |',
      '',
      '<!-- blk:blk_b8 -->',
      '![图](space-asset://asset_1)',
      '',
      '<!-- blk:blk_b9 -->',
      ':::callout{tone="warn" title="注意" collapsed=true}',
      '别删库',
      ':::',
      '',
      '<!-- blk:blk_b10 -->',
      ':::mindmap{objectId="obj_1" caption="脑图"}',
      ':::',
      '',
      '<!-- blk:blk_b11 -->',
      ':::component{objectId="obj_2" title="图表"}',
      ':::',
      '',
      '<!-- blk:blk_b12 -->',
      ':::opaque{type="mystery"}',
      '[unsupported node]',
      ':::',
    ].join('\n');
    expect(projectDocument(doc(blocks)).markdown).toBe(`${expected}\n`);
  });
});

describe('inlineToMarkdown and projectBlock', () => {
  it('renders marks in a deterministic order', () => {
    expect(
      inlineToMarkdown([
        { type: 'text', text: 'x', marks: [{ type: 'italic' }, { type: 'bold' }] },
      ]),
    ).toBe('***x***');
    expect(
      inlineToMarkdown([
        { type: 'text', text: 'code', marks: [{ type: 'bold' }, { type: 'code' }] },
      ]),
    ).toBe('**`code`**');
    expect(
      inlineToMarkdown([
        { type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href: 'https://a.b' } }] },
      ]),
    ).toBe('[链接](https://a.b)');
  });

  it('escapes Markdown syntax and keeps hard breaks', () => {
    expect(
      inlineToMarkdown([{ type: 'text', text: '- 不是列表\n# 不是标题' }]),
    ).toBe('\\- 不是列表\n\\# 不是标题');
    expect(inlineToMarkdown([{ type: 'text', text: 'a' }, { type: 'hardBreak' }])).toBe('a\n');
    expect(inlineToMarkdown([{ type: 'text', text: 'a*b_c[d]' }])).toBe('a\\*b\\_c\\[d\\]');
  });

  it('renders a single block without anchors', () => {
    expect(
      projectBlock(
        createBlockNode('blk_h', 'heading', {
          attrs: { level: 3 },
          content: [{ type: 'text', text: '标题' }],
        }),
      ),
    ).toBe('### 标题');
    expect(
      projectBlock(
        createBlockNode('blk_code', 'codeBlock', {
          attrs: { lang: 'js' },
          content: [{ type: 'text', text: 'a\nb' }],
        }),
      ),
    ).toBe('```js\na\nb\n```');
  });
});

describe('projection windowing', () => {
  const blocks = ['a', 'b', 'c'].map((text) =>
    createBlockNode(`blk_${text}`, 'paragraph', {
      content: [{ type: 'text', text }],
    }),
  );

  it('applies limit and marks the projection truncated', () => {
    const result = projectDocument(doc(blocks), { limit: 2 });
    expect(result.markdown).toBe(
      '<!-- blk:blk_a -->\na\n\n<!-- blk:blk_b -->\nb\n',
    );
    expect(result.includedBlocks).toEqual([
      { id: 'blk_a', type: 'paragraph' },
      { id: 'blk_b', type: 'paragraph' },
    ]);
    expect(result.truncated).toBe(true);
  });

  it('starts after the given top-level block', () => {
    const result = projectDocument(doc(blocks), { after: 'blk_a', anchors: false });
    expect(result.markdown).toBe('b\n\nc\n');
    expect(result.includedBlocks.map((block) => block.id)).toEqual(['blk_b', 'blk_c']);
    expect(result.truncated).toBe(false);
  });

  it('projects only the requested top-level block ids', () => {
    const result = projectDocument(doc(blocks), {
      blockIds: ['blk_c', 'blk_a', 'blk_missing'],
      anchors: false,
    });
    expect(result.markdown).toBe('a\n\nc\n');
    expect(result.truncated).toBe(false);
  });

  it('returns an empty projection for an empty selection', () => {
    const result = projectDocument(doc(blocks), { blockIds: [], anchors: false });
    expect(result).toEqual({ markdown: '', includedBlocks: [], truncated: false });
  });

  it('stops before a block that overflows and reports truncation', () => {
    const result = projectDocument(doc(blocks), { maxChars: 25 });
    expect(result.includedBlocks).toEqual([{ id: 'blk_a', type: 'paragraph' }]);
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(25);
  });

  it('character-safely truncates the first block when it alone overflows', () => {
    const long = createBlockNode('blk_long', 'paragraph', {
      content: [{ type: 'text', text: 'x'.repeat(100) }],
    });
    const result = projectDocument(doc([long]), { maxChars: 50, anchors: false });
    expect(result.markdown).toBe(`${'x'.repeat(49)}\n`);
    expect(result.includedBlocks).toEqual([{ id: 'blk_long', type: 'paragraph' }]);
    expect(result.truncated).toBe(true);
  });

  it('counts anchors against the budget when truncating the first block', () => {
    const long = createBlockNode('blk_long', 'paragraph', {
      content: [{ type: 'text', text: 'y'.repeat(100) }],
    });
    const result = projectDocument(doc([long]), { maxChars: 40 });
    expect(result.markdown.startsWith('<!-- blk:blk_long -->\n')).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(40);
    expect(result.truncated).toBe(true);
    expect(result.includedBlocks).toEqual([{ id: 'blk_long', type: 'paragraph' }]);
  });

  it('does not split surrogate pairs when truncating', () => {
    const emoji = createBlockNode('blk_emoji', 'paragraph', {
      content: [{ type: 'text', text: '😀'.repeat(60) }],
    });
    const result = projectDocument(doc([emoji]), { maxChars: 20, anchors: false });
    const body = result.markdown.replace(/\n$/, '');
    expect(result.truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(19);
    expect(body.length % 2).toBe(0);
  });
});

describe('parseMarkdownBlocks round-trip', () => {
  const source = [
    '# 标题',
    '',
    '第一段，含 **加粗**、*斜体*、`代码`、==高亮==、<u>下划线</u>、~~删除~~ 和 [链接](https://example.com)。',
    '',
    '- 项目一',
    '- 项目二',
    '  - 嵌套项',
    '',
    '1. 有序一',
    '2. 有序二',
    '',
    '- [ ] 待办',
    '- [x] 已完成',
    '',
    '> 引用段落',
    '',
    '```ts',
    'const value = 1;',
    '```',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    ':::callout{tone="info" title="提示"}',
    '提示内容',
    ':::',
    '',
    '![图](space-asset://asset_1)',
  ].join('\n');

  it('parses the supported subset into validated blocks', () => {
    const blocks = parse(source);
    validateAlterDoc(doc(blocks));
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'table',
      'callout',
      'image',
    ]);
    expect(projectDocument(doc(blocks), { anchors: false }).markdown).toBe(`${source}\n`);
  });

  it('keeps nested lists, task state and table cells', () => {
    const blocks = parse(source);
    const bullet = blocks[2]!;
    const nested = bullet.children?.[1]?.children?.[1];
    expect(nested?.type).toBe('bulletList');
    expect(nested?.children?.[0]?.children?.[0]?.content).toEqual([
      { type: 'text', text: '嵌套项' },
    ]);
    const task = blocks[4]!;
    expect(task.children?.map((item) => item.attrs.checked)).toEqual([false, true]);
    const table = blocks[7]!;
    expect(table.attrs.headerRows).toBe(1);
    expect(table.children?.[1]?.children?.[1]?.content).toEqual([
      { type: 'text', text: '2' },
    ]);
  });

  it('round-trips inline escaping without losing text', () => {
    const blocks = parse('a*b_c~d`e[f]g|j');
    expect(blocks[0]?.content).toEqual([{ type: 'text', text: 'a*b_c~d`e[f]g|j' }]);
    const again = projectDocument(doc(blocks), { anchors: false }).markdown;
    const reparsed = parse(again);
    expect(projectDocument(doc(reparsed), { anchors: false }).markdown).toBe(again);
  });

  it('round-trips multi-paragraph text and hard breaks', () => {
    const projected = projectDocument(
      doc([
        createBlockNode('blk_p', 'paragraph', {
          content: [{ type: 'text', text: '第一行\n第二行' }],
        }),
      ]),
      { anchors: false },
    ).markdown;
    expect(projected).toBe('第一行\n第二行\n');
    const reparsed = parse(projected);
    const reprojected = projectDocument(doc(reparsed), { anchors: false }).markdown;
    expect(reprojected).toBe(projected);
  });

  it('round-trips nested callouts', () => {
    const nested = [
      ':::callout{tone="info"}',
      '外层',
      '',
      ':::callout{tone="warn"}',
      '内层',
      ':::',
      ':::',
    ].join('\n');
    expect(roundTrip(nested)).toBe(`${nested}\n`);
  });

  it('round-trips the anchored projection back to the same blocks', () => {
    const blocks = parse(source);
    const anchored = projectDocument(doc(blocks)).markdown;
    expect(anchored).toContain('<!-- blk:');
    const reparsed = parse(anchored);
    expect(projectDocument(doc(reparsed), { anchors: false }).markdown).toBe(`${source}\n`);
  });

  it('escapes table cell pipes so tables survive a round-trip', () => {
    const tableDoc = doc([
      createBlockNode('blk_t', 'table', {
        attrs: { headerRows: 1 },
        children: [
          createBlockNode('blk_tr1', 'tableRow', {
            children: [
              createBlockNode('blk_c1', 'tableCell', {
                content: [{ type: 'text', text: 'a|b' }],
              }),
              createBlockNode('blk_c2', 'tableCell', {
                content: [{ type: 'text', text: 'c' }],
              }),
            ],
          }),
          createBlockNode('blk_tr2', 'tableRow', {
            children: [
              createBlockNode('blk_c3', 'tableCell', {
                content: [{ type: 'text', text: '1' }],
              }),
              createBlockNode('blk_c4', 'tableCell', {
                content: [{ type: 'text', text: '2' }],
              }),
            ],
          }),
        ],
      }),
    ]);
    const projected = projectDocument(tableDoc, { anchors: false }).markdown;
    expect(projected).toBe('| a\\|b | c |\n| --- | --- |\n| 1 | 2 |\n');
    const reparsed = parse(projected);
    expect(reparsed[0]?.children?.[0]?.children?.[0]?.content).toEqual([
      { type: 'text', text: 'a|b' },
    ]);
  });

  it('accepts multiple top-level blocks and validates them', () => {
    const blocks = parse(['# 一', '', '二', '', '---'].join('\n'));
    validateAlterDoc(doc(blocks));
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'divider']);
  });
});

describe('directive attributes', () => {
  it('maps directive attributes onto node attributes', () => {
    const blocks = parse(
      [
        ':::callout{tone="danger" title="标题" icon="alert" collapsed=false}',
        '内容',
        ':::',
        '',
        ':::mindmap{objectId="obj_1" caption="说明"}',
        ':::',
        '',
        ':::component{objectId="obj_2" title="组件" description="描述"}',
        ':::',
      ].join('\n'),
    );
    expect(blocks[0]?.attrs).toEqual({
      tone: 'danger',
      title: '标题',
      icon: 'alert',
      collapsed: false,
    });
    expect(blocks[0]?.children?.length).toBe(1);
    expect(blocks[1]?.attrs).toEqual({ objectId: 'obj_1', caption: '说明' });
    expect(blocks[2]?.attrs).toEqual({
      objectId: 'obj_2',
      title: '组件',
      description: '描述',
    });
  });

  it('ignores block id hints and keeps quoted values with escapes', () => {
    const blocks = parse(
      [
        ':::callout{tone="info" title="包含 \\"引号\\" 的标题" #blk_external}',
        '内容',
        ':::',
      ].join('\n'),
    );
    expect(blocks[0]?.attrs.title).toBe('包含 "引号" 的标题');
    expect(blocks[0]?.attrs).not.toHaveProperty('id');
    expect(projectBlock(blocks[0]!)).toBe(
      ':::callout{tone="info" title="包含 \\"引号\\" 的标题"}\n内容\n:::',
    );
  });
});

describe('parse errors', () => {
  it('rejects unknown directives with a line number', () => {
    const error = expectDocumentError(
      () => parse(['# 标题', '', ':::chart{type="bar"}', ':::'].join('\n')),
      'parse/unsupported',
    );
    expect(error.message).toContain('第 3 行');
    expect(error.message).toContain('chart');
  });

  it('rejects unknown directive attributes', () => {
    expectDocumentError(
      () => parse(':::callout{tone="info" color="red"}\n内容\n:::\n'),
      'parse/unsupported',
    );
  });

  it('rejects invalid enum values', () => {
    const error = expectDocumentError(
      () => parse(':::callout{tone="oops"}\n内容\n:::\n'),
      'node/schema-invalid',
    );
    expect(error.message).toContain('第 1 行');
    expect(error.message).toContain('tone');
  });

  it('rejects missing required directive attributes', () => {
    const error = expectDocumentError(
      () => parse(':::callout{title="x"}\n内容\n:::\n'),
      'node/schema-invalid',
    );
    expect(error.message).toContain('tone');
  });

  it('rejects object directives with a non-empty body', () => {
    expectDocumentError(
      () => parse(':::mindmap{objectId="obj_1"}\npayload\n:::\n'),
      'parse/unsupported',
    );
  });

  it('rejects unclosed containers and stray closers', () => {
    const unclosed = expectDocumentError(
      () => parse(':::callout{tone="info"}\n内容\n'),
      'parse/unsupported',
    );
    expect(unclosed.message).toContain('未闭合');
    expectDocumentError(() => parse(':::\n'), 'parse/unsupported');
  });

  it('rejects unknown HTML', () => {
    const error = expectDocumentError(() => parse('<div>块</div>'), 'parse/unsupported');
    expect(error.message).toContain('第 1 行');
  });

  it('rejects unclosed link titles and invalid hrefs', () => {
    expectDocumentError(
      () => parse('[x](https://a.b "title)'),
      'parse/unsupported',
    );
    expectDocumentError(
      () => parse('[x](javascript:alert(1))'),
      'node/schema-invalid',
    );
  });
});

describe('image assets', () => {
  it('accepts space-asset references when no asset store is supplied', () => {
    const blocks = parse('![图](space-asset://asset_1 "说明")');
    expect(blocks[0]?.type).toBe('image');
    expect(blocks[0]?.attrs).toEqual({ assetId: 'asset_1', alt: '图', caption: '说明' });
    expect(projectBlock(blocks[0]!)).toBe(
      '![图](space-asset://asset_1 "说明")',
    );
  });

  it('rejects non space-asset image URLs', () => {
    const error = expectDocumentError(
      () => parse('![图](https://example.com/a.png)'),
      'parse/unsupported',
    );
    expect(error.message).toContain('space-asset://');
  });

  it('validates asset existence when hasAsset is supplied', () => {
    const hasAsset = (id: string): boolean => id === 'asset_ok';
    expect(() => parse('![图](space-asset://asset_ok)', { hasAsset })).not.toThrow();
    const error = expectDocumentError(
      () => parse('![图](space-asset://asset_missing)', { hasAsset }),
      'parse/unsupported',
    );
    expect(error.message).toContain('asset_missing');
    expect(error.message).toContain('第 1 行');
  });

  it('rejects inline images inside paragraphs', () => {
    expectDocumentError(
      () => parse('前文 ![图](space-asset://asset_1)'),
      'parse/unsupported',
    );
  });
});

describe('parse edge cases', () => {
  it('ignores projection anchors pasted back into Markdown', () => {
    const blocks = parse('<!-- blk:blk_a -->\n段落\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('accepts ordered lists with a custom start', () => {
    const blocks = parse('3. 三\n4. 四');
    expect(blocks[0]?.type).toBe('orderedList');
    expect(blocks[0]?.attrs.start).toBe(3);
    expect(projectBlock(blocks[0]!)).toBe('3. 三\n4. 四');
  });

  it('accepts fences longer than the content backticks', () => {
    const blocks = parse(['````md', '```', '````'].join('\n'));
    expect(blocks[0]?.type).toBe('codeBlock');
    expect(blocks[0]?.content).toEqual([{ type: 'text', text: '```' }]);
    expect(projectBlock(blocks[0]!)).toBe('````md\n```\n````');
  });

  it('rejects unclosed fenced code', () => {
    expectDocumentError(() => parse('```ts\na'), 'parse/unsupported');
  });

  it('rejects unsupported HTML in inline content', () => {
    expectDocumentError(() => parse('a <span>b</span>'), 'parse/unsupported');
  });

  it('parses empty and whitespace-only sources as an empty document', () => {
    expect(parse('')).toEqual([]);
    expect(parse('  \n\n')).toEqual([]);
  });
});
