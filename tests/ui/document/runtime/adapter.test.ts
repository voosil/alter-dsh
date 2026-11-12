// @vitest-environment jsdom
/**
 * Document runtime: AST → frozen editor HTML → AST round-trips, block-id
 * stability, frozen card syntax, inline asset references and comment anchors.
 *
 * The runtime keeps the pre-rebuild editor's HTML syntax: the history diff
 * preview projects AST into it and clipboard paste parses it back. These tests
 * lock the AST side of that contract.
 */
import { describe, expect, it } from 'vitest';
import {
  alterDocToEditorHtml,
  anchorForQuote,
  computeAstOperations,
  parseDocumentContent,
  parseEditorHtml,
  readRevisionOf,
  serializeDocument,
} from '../../../../src/document/runtime';
import type { AlterDoc, BlockNode } from '../../../../src/document/types';

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

/** Remove empty `content`/`children` arrays (the canonical AST form). */
function normalize(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.map((node) => {
    const out: BlockNode = { id: node.id, type: node.type, attrs: node.attrs };
    if (node.content !== undefined && node.content.length > 0) {
      out.content = node.content;
    }
    if (node.children !== undefined && node.children.length > 0) {
      out.children = normalize(node.children);
    }
    return out;
  });
}

function richDoc(): AlterDoc {
  return {
    format: 'alter-doc/1',
    schemaVersion: 1,
    revision: 7,
    blocks: [
      block('blk_h1', 'heading', { level: 1 }, {
        content: [{ type: 'text', text: '鉴权方案' }],
      }),
      block('blk_para', 'paragraph', {}, {
        content: [
          { type: 'text', text: '普通 ' },
          { type: 'text', text: '粗斜', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'hardBreak' },
          { type: 'text', text: '下划线', marks: [{ type: 'underline' }] },
          { type: 'text', text: '删除线', marks: [{ type: 'strike' }] },
          { type: 'text', text: '高亮', marks: [{ type: 'highlight' }] },
          { type: 'text', text: '代码', marks: [{ type: 'code' }] },
          {
            type: 'text',
            text: '链接',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/docs' } }],
          },
        ],
      }),
      block('blk_ul', 'bulletList', {}, {
        children: [
          block('blk_li1', 'listItem', {}, {
            children: [
              block('blk_lip1', 'paragraph', {}, {
                content: [{ type: 'text', text: '项目一' }],
              }),
              block('blk_nested', 'bulletList', {}, {
                children: [
                  block('blk_li2', 'listItem', {}, {
                    children: [
                      block('blk_lip2', 'paragraph', {}, {
                        content: [{ type: 'text', text: '嵌套项' }],
                      }),
                    ],
                  }),
                ],
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
          block('blk_t1', 'listItem', { checked: true }, {
            children: [
              block('blk_tip1', 'paragraph', {}, {
                content: [{ type: 'text', text: '已完成' }],
              }),
              block('blk_tnested', 'bulletList', {}, {
                children: [
                  block('blk_tnested_item', 'listItem', {}, {
                    children: [
                      block('blk_tnested_p', 'paragraph', {}, {
                        content: [{ type: 'text', text: '待办子项' }],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          block('blk_t2', 'listItem', { checked: false }, {
            children: [
              block('blk_tip2', 'paragraph', {}, {
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
        content: [{ type: 'text', text: 'const answer = 42;\nconsole.log(answer);' }],
      }),
      block('blk_hr', 'divider'),
      block('blk_table', 'table', { headerRows: 1 }, {
        children: [
          block('blk_row1', 'tableRow', {}, {
            children: [
              block('blk_cell11', 'tableCell', {}, {
                content: [{ type: 'text', text: '列一' }],
              }),
              block('blk_cell12', 'tableCell', {}, {
                content: [{ type: 'text', text: '列二' }],
              }),
            ],
          }),
          block('blk_row2', 'tableRow', {}, {
            children: [
              block('blk_cell21', 'tableCell', {}, {
                content: [{ type: 'text', text: '值一' }],
              }),
              block('blk_cell22', 'tableCell', {}, { content: [] }),
            ],
          }),
        ],
      }),
      block('blk_image', 'image', {
        assetId: 'asset_img1',
        alt: '架构图',
        caption: '图 1',
        width: '320px',
      }),
      block('blk_file', 'file', {
        assetId: 'asset_file1',
        name: '需求说明.pdf',
        mime: 'application/pdf',
        bytes: 2048,
      }),
      block('blk_bookmark', 'bookmark', {
        url: 'https://example.com/guide',
        title: '外部指南',
        description: '背景资料',
      }),
      block('blk_doc_link', 'docLink', {
        docId: 'doc-related',
        title: '相关文档',
      }),
      block('blk_callout', 'callout', { tone: 'warn', title: '注意' }, {
        children: [
          block('blk_cp', 'paragraph', {}, {
            content: [{ type: 'text', text: '高亮块正文' }],
          }),
        ],
      }),
      block('blk_mindmap', 'mindmap', {
        objectId: 'obj_map1',
        caption: '目标拆解',
      }),
      block('blk_component', 'component', {
        objectId: 'obj_cmp1',
        title: '指标看板',
        description: '展示核心指标',
      }),
    ],
  };
}

const docPath = (docId: string) => `#/space/sp-1/doc/${docId}`;

describe('document runtime: AST ↔ frozen editor HTML', () => {
  it('round-trips every v0 node type, attribute and mark', () => {
    const source = richDoc();
    const html = alterDocToEditorHtml(source, { docPath });
    expect(html).toContain('data-block-id="blk_h1"');
    expect(html).toContain('data-todo');
    expect(html).toContain('data-asset-id="asset_file1"');
    expect(html).toContain('data-object-card data-kind="mindmap"');
    const parsed = parseEditorHtml(html);
    expect(parsed.warnings).toEqual([]);
    expect(normalize(parsed.blocks)).toEqual(normalize(source.blocks));
  });

  it('round-trips the image width formats accepted by the editor', () => {
    for (const width of ['auto', '50%', '320px', '12rem']) {
      const doc: AlterDoc = {
        format: 'alter-doc/1',
        schemaVersion: 1,
        revision: 1,
        blocks: [
          block('blk_img', 'image', { assetId: 'asset_1', alt: '图', width }),
        ],
      };
      const parsed = parseEditorHtml(alterDocToEditorHtml(doc));
      expect(parsed.blocks[0]?.attrs.width).toBe(width);
    }
  });

  it('round-trips a near-limit document (≈4990 blocks) without truncation', () => {
    const blocks = Array.from({ length: 4990 }, (_, index) =>
      block(`blk_${index}`, 'paragraph', {}, {
        content: [{ type: 'text', text: `段${index}` }],
      }),
    );
    const doc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks,
    };
    const start = performance.now();
    const html = alterDocToEditorHtml(doc);
    const parsed = parseEditorHtml(html);
    const elapsed = performance.now() - start;
    expect(parsed.blocks).toHaveLength(4990);
    expect(parsed.blocks[0]?.id).toBe('blk_0');
    expect(parsed.blocks.at(-1)?.id).toBe('blk_4989');
    expect(normalize(parsed.blocks)).toEqual(normalize(blocks));
    // Recorded for the acceptance notes (no brittle threshold).
    console.log(
      `adapter 4990-block round-trip: ${elapsed.toFixed(1)}ms (HTML ${html.length} chars)`,
    );
  });

  it('keeps block ids stable across a second round-trip', () => {
    const first = parseEditorHtml(
      alterDocToEditorHtml(richDoc(), { docPath }),
    );
    const second = parseEditorHtml(
      alterDocToEditorHtml(
        { ...richDoc(), blocks: first.blocks },
        { docPath },
      ),
    );
    expect(second.blocks.map((item) => item.id)).toEqual(
      first.blocks.map((item) => item.id),
    );
    expect(second.blocks).toEqual(first.blocks);
  });

  it('escapes text and attributes instead of emitting markup', () => {
    const doc: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        block('blk_p', 'paragraph', {}, {
          content: [
            { type: 'text', text: '<script>alert("x")</script> & 结尾' },
          ],
        }),
        block('blk_bm', 'bookmark', {
          url: 'https://example.com/?a=1&b="2"',
          title: '<b>标题</b>',
        }),
      ],
    };
    const html = alterDocToEditorHtml(doc);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('data-block-id="blk_p"');
    const parsed = parseEditorHtml(html);
    expect(parsed.blocks[0]?.content?.[0]).toEqual({
      type: 'text',
      text: '<script>alert("x")</script> & 结尾',
    });
    expect(parsed.blocks[1]?.attrs.url).toBe(
      'https://example.com/?a=1&b="2"',
    );
  });

  it('reuses explicit ids, regenerates duplicates and warns on illegal ids', () => {
    const html =
      '<p data-block-id="blk_same">一</p>' +
      '<p data-block-id="blk_same">二</p>' +
      '<p data-block-id="not-a-block-id">三</p>';
    const parsed = parseEditorHtml(html);
    expect(parsed.blocks[0]!.id).toBe('blk_same');
    expect(parsed.blocks[1]!.id).not.toBe('blk_same');
    expect(parsed.blocks[1]!.id).toMatch(/^blk_/);
    expect(parsed.blocks[2]!.id).toMatch(/^blk_/);
    expect(parsed.warnings.join('\n')).toContain('重复的 block id');
    expect(parsed.warnings.join('\n')).toContain('不合法的 block id');
  });

  it('degrades unknown/unsupported markup to visible content with warnings', () => {
    const html =
      '<section><h4>四级标题</h4>' +
      '<iframe src="https://evil.test"></iframe>' +
      '<script>alert(1)</script>' +
      '<style>body{display:none}</style>' +
      '<p><span style="color:red">样式文字</span></p>' +
      '<mystery-block>未知结构</mystery-block></section>';
    const parsed = parseEditorHtml(html);
    const json = JSON.stringify(parsed.blocks);
    expect(json).toContain('四级标题');
    expect(json).toContain('样式文字');
    expect(json).toContain('未知结构');
    expect(json).not.toContain('alert(1)');
    expect(json).not.toContain('display:none');
    const warnings = parsed.warnings.join('\n');
    expect(warnings).toContain('iframe');
    expect(warnings).toContain('script');
    expect(warnings).toContain('style');
  });
});

describe('document runtime: frozen editor syntax', () => {
  it('parses old cards, todos, dividers and inline web links', () => {
    const html =
      '<p>前文<a data-web-link href="https://example.com/a">网页链接</a></p>' +
      '<a data-link-card="https://example.com/card" href="https://example.com/card">' +
      '<strong>卡片标题</strong><span>卡片描述</span></a>' +
      '<a data-doc-link="doc-9" href="#/space/sp-1/doc/doc-9">' +
      '<span data-doc-icon contenteditable="false"></span>内链标题</a>' +
      '<div data-todo data-checked="true"><span data-todo-box contenteditable="false"></span>' +
      '<span data-todo-text>待办项</span></div>' +
      '<div data-divider contenteditable="false"><hr></div>';
    const parsed = parseEditorHtml(html);
    const types = parsed.blocks.map((item) => item.type);
    expect(types).toContain('bookmark');
    expect(types).toContain('docLink');
    expect(types).toContain('taskList');
    expect(types).toContain('divider');
    const paragraph = parsed.blocks.find((item) => item.type === 'paragraph');
    expect(paragraph?.content?.[0]).toMatchObject({
      type: 'text',
      text: '前文',
    });
    expect(JSON.stringify(paragraph)).toContain(
      '"href":"https://example.com/a"',
    );
    const bookmark = parsed.blocks.find((item) => item.type === 'bookmark');
    expect(bookmark?.attrs).toMatchObject({
      url: 'https://example.com/card',
      title: '卡片标题',
      description: '卡片描述',
    });
    const docLink = parsed.blocks.find((item) => item.type === 'docLink');
    expect(docLink?.attrs).toMatchObject({ docId: 'doc-9', title: '内链标题' });
    const task = parsed.blocks.find((item) => item.type === 'taskList');
    expect(task?.children?.[0]?.attrs.checked).toBe(true);
  });

  it('resolves inline data-URL images/files through the import callbacks', () => {
    const html =
      '<p><img src="data:image/png;base64,AAAA" alt="图"></p>' +
      '<span data-file="报告.pdf" data-href="data:application/pdf;base64,AAAA" data-size="3 B">' +
      '<span data-file-icon></span><span>报告.pdf · 3 B</span></span>';
    const parsed = parseEditorHtml(html, {
      assetIdFor: () => 'asset_img9',
      fileAssetFor: () => ({
        assetId: 'asset_file9',
        mime: 'application/pdf',
        bytes: 3,
        name: '报告.pdf',
      }),
    });
    const image = parsed.blocks.find((item) => item.type === 'image');
    expect(image?.attrs).toMatchObject({ assetId: 'asset_img9', alt: '图' });
    const file = parsed.blocks.find((item) => item.type === 'file');
    expect(file?.attrs).toMatchObject({
      assetId: 'asset_file9',
      name: '报告.pdf',
      mime: 'application/pdf',
      bytes: 3,
    });
  });

  it('degrades unresolved data URLs to placeholders with warnings', () => {
    const parsed = parseEditorHtml(
      '<p><img src="data:image/png;base64,AAAA" alt="图"></p>' +
        '<span data-file="x.pdf" data-href="data:application/pdf;base64,AAAA">x.pdf</span>',
    );
    expect(parsed.blocks.every((item) => item.type === 'paragraph')).toBe(true);
    const json = JSON.stringify(parsed.blocks);
    expect(json).toContain('[图片');
    expect(json).toContain('[文件');
    expect(parsed.warnings.join('\n')).toContain('图片资源尚未上传');
    expect(parsed.warnings.join('\n')).toContain('文件资源尚未上传');
  });
});

describe('document runtime: helpers', () => {
  it('parses stored content and reads revisions', () => {
    const doc = richDoc();
    const content = serializeDocument(doc);
    expect(parseDocumentContent(content)).toEqual(doc);
    expect(parseDocumentContent('<p>旧 HTML</p>')).toBeUndefined();
    expect(readRevisionOf({ revision: 4 })).toBe(4);
    expect(readRevisionOf({ revision: -1 })).toBeUndefined();
    expect(readRevisionOf(null)).toBeUndefined();
  });

  it('maps a unique quote to a top-level block anchor', () => {
    const blocks = richDoc().blocks;
    const anchor = anchorForQuote(blocks, '高亮块正文');
    expect(anchor).not.toBeNull();
    expect(anchor!.blockId).toBe('blk_callout');
    expect(
      blockTextOf(blocks, 'blk_callout').slice(
        anchor!.offset,
        anchor!.offset + anchor!.length,
      ),
    ).toBe('高亮块正文');
    // Ambiguous quotes and missing quotes are not anchored.
    expect(anchorForQuote(blocks, '不存在的内容')).toBeNull();
    const ambiguous: BlockNode[] = [
      block('blk_a', 'paragraph', {}, {
        content: [{ type: 'text', text: '重复内容' }],
      }),
      block('blk_b', 'paragraph', {}, {
        content: [{ type: 'text', text: '重复内容' }],
      }),
    ];
    expect(anchorForQuote(ambiguous, '重复内容')).toBeNull();
  });

  it('computes a block diff for one runtime save', () => {
    const oldDoc = richDoc();
    const newDoc: AlterDoc = {
      ...oldDoc,
      blocks: oldDoc.blocks.map((item) =>
        item.id === 'blk_h1'
          ? {
              ...item,
              content: [{ type: 'text' as const, text: '鉴权方案（改）' }],
            }
          : item,
      ),
    };
    const ops = computeAstOperations(oldDoc, newDoc);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]).toMatchObject({ op: 'replace_block', target: 'blk_h1' });
    expect(computeAstOperations(oldDoc, { ...oldDoc })).toEqual([]);
  });
});

function blockTextOf(blocks: readonly BlockNode[], id: string): string {
  const find = (items: readonly BlockNode[]): BlockNode | undefined => {
    for (const item of items) {
      if (item.id === id) return item;
      const nested = find(item.children ?? []);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const target = find(blocks);
  if (target === undefined) return '';
  const parts: string[] = [];
  for (const node of target.content ?? []) {
    parts.push(node.type === 'text' ? node.text : '\n');
  }
  for (const child of target.children ?? []) {
    if (parts.length > 0) parts.push('\n');
    parts.push(blockTextOf([child], child.id));
  }
  return parts.join('');
}

describe('document runtime: empty block semantics (D2)', () => {
  /** One document where every empty block shape the old editor can produce. */
  function emptyBlocksDoc(): AlterDoc {
    return {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 3,
      blocks: [
        block('blk_p_empty', 'paragraph'),
        block('blk_h1_empty', 'heading', { level: 1 }),
        block('blk_h2_empty', 'heading', { level: 2 }),
        block('blk_h3_empty', 'heading', { level: 3 }),
        block('blk_ul_empty', 'bulletList', {}, {
          children: [
            block('blk_li_empty', 'listItem'),
            block('blk_li_text', 'listItem', {}, {
              children: [
                block('blk_li_p', 'paragraph', {}, {
                  content: [{ type: 'text', text: '有内容' }],
                }),
              ],
            }),
            block('blk_li_empty2', 'listItem'),
          ],
        }),
        block('blk_ol_empty', 'orderedList', {}, {
          children: [block('blk_oli_empty', 'listItem')],
        }),
        block('blk_task_empty', 'taskList', {}, {
          children: [block('blk_ti_empty', 'listItem', { checked: false })],
        }),
        block('blk_table_empty', 'table', { headerRows: 1 }, {
          children: [
            block('blk_row1', 'tableRow', {}, {
              children: [
                block('blk_cell_empty', 'tableCell'),
                block('blk_cell_text', 'tableCell', {}, {
                  content: [{ type: 'text', text: 'x' }],
                }),
              ],
            }),
          ],
        }),
        block('blk_quote_empty', 'blockquote'),
        block('blk_callout_empty', 'callout', { tone: 'info' }),
        block('blk_p_after', 'paragraph', {}, {
          content: [{ type: 'text', text: '结尾' }],
        }),
      ],
    };
  }

  it('round-trips empty paragraphs/headings/list items/task items/cells unchanged', () => {
    const source = emptyBlocksDoc();
    const html = alterDocToEditorHtml(source);
    // Empty blocks keep the editable `<br>` caret carrier of the frozen DOM.
    expect(html).toContain('<p data-block-id="blk_p_empty"><br></p>');
    expect(html).toContain('<h1 data-block-id="blk_h1_empty"><br></h1>');
    expect(html).toContain('<h3 data-block-id="blk_h3_empty"><br></h3>');
    expect(html).toContain('<li data-block-id="blk_li_empty"><br></li>');
    expect(html).toContain('<li data-block-id="blk_oli_empty"><br></li>');
    expect(html).toContain('<th data-block-id="blk_cell_empty"><br></th>');
    // Empty containers keep their wrapper (they do not collapse).
    expect(html).toContain('<blockquote data-block-id="blk_quote_empty"><br></blockquote>');
    expect(html).toContain('data-kind="callout"');
    expect(html).toContain('data-block-id="blk_callout_empty"');

    const parsed = parseEditorHtml(html);
    expect(parsed.warnings).toEqual([]);
    expect(normalize(parsed.blocks)).toEqual(normalize(source.blocks));
    // Saving this round-trip must not create or delete blocks.
    expect(
      computeAstOperations(source, { ...source, blocks: parsed.blocks }),
    ).toEqual([]);
  });

  it('keeps empty blocks in place across repeated editor round-trips', () => {
    const source = emptyBlocksDoc();
    const first = parseEditorHtml(alterDocToEditorHtml(source));
    const second = parseEditorHtml(alterDocToEditorHtml({
      ...source,
      blocks: first.blocks,
    }));
    expect(second.blocks).toEqual(first.blocks);
    // Empty blocks still occupy their positions (no collapsing into one).
    expect(second.blocks).toHaveLength(source.blocks.length);
    expect(second.blocks.map((item) => item.id)).toEqual(
      source.blocks.map((item) => item.id),
    );
  });
});

describe('merged table spans in the frozen HTML syntax', () => {
  /** One table with a 2×2 merge, plus a plain cell beside it. */
  function mergedDoc(): AlterDoc {
    return {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 3,
      blocks: [
        block('blk_table', 'table', { headerRows: 1 }, {
          children: [
            block('blk_row1', 'tableRow', {}, {
              children: [
                block('blk_cell1', 'tableCell', { colspan: 2, rowspan: 2 }, {
                  content: [{ type: 'text', text: '合并' }],
                }),
                block('blk_cell2', 'tableCell', {}, {
                  content: [{ type: 'text', text: '普通' }],
                }),
              ],
            }),
            // Covered by the rowspan above: no cells of its own.
            block('blk_row2', 'tableRow'),
          ],
        }),
      ],
    };
  }

  it('emits colspan/rowspan only when they change the grid', () => {
    const html = alterDocToEditorHtml(mergedDoc());
    expect(html).toContain(
      '<th data-block-id="blk_cell1" colspan="2" rowspan="2">合并</th>',
    );
    expect(html).toContain('<th data-block-id="blk_cell2">普通</th>');
    expect(html).not.toContain('colspan="1"');
    expect(html).not.toContain('rowspan="1"');
  });

  it('parses spans back into AST attrs (paste round-trip)', () => {
    const parsed = parseEditorHtml(alterDocToEditorHtml(mergedDoc()));
    expect(parsed.warnings).toEqual([]);
    expect(normalize(parsed.blocks)).toEqual(normalize(mergedDoc().blocks));

    const pasted = parseEditorHtml(
      '<table><tbody><tr><th colspan="2" rowspan="2">A</th></tr>' +
        '<tr></tr></tbody></table>',
    );
    const cell = pasted.blocks[0]?.children?.[0]?.children?.[0];
    expect(cell?.attrs).toEqual({ colspan: 2, rowspan: 2 });
    // 1 and out-of-contract values are normalized away/clamped.
    const plain = parseEditorHtml(
      '<table><tbody><tr><td colspan="1">B</td><td colspan="99">C</td>' +
        '</tr></tbody></table>',
    );
    const cells = plain.blocks[0]?.children?.[0]?.children ?? [];
    expect(cells[0]?.attrs).toEqual({});
    expect(cells[1]?.attrs).toEqual({ colspan: 50 });
  });
});
