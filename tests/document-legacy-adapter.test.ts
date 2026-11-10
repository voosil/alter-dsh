// @vitest-environment jsdom
/**
 * Legacy editor adapter: AST → old contentEditable HTML → AST round-trips,
 * block-id stability, legacy card syntax, inline asset materialization and
 * comment anchors.
 *
 * The adapter must keep the pre-rebuild editor's DOM syntax so the restored UI
 * keeps its exact look; these tests lock the AST side of that contract.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  alterDocToEditorHtml,
  anchorForQuote,
  computeAstOperations,
  materializeLegacyAssets,
  parseDocumentContent,
  parseLegacyHtml,
  readRevisionOf,
  serializeDocument,
} from '../src/document/legacy';
import type { AlterDoc, BlockNode } from '../src/document/types';

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

describe('legacy adapter: AST ↔ old editor HTML', () => {
  it('round-trips every v0 node type, attribute and mark', () => {
    const source = richDoc();
    const html = alterDocToEditorHtml(source, { docPath });
    expect(html).toContain('data-block-id="blk_h1"');
    expect(html).toContain('data-todo');
    expect(html).toContain('data-asset-id="asset_file1"');
    expect(html).toContain('data-object-card data-kind="mindmap"');
    const parsed = parseLegacyHtml(html);
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
      const parsed = parseLegacyHtml(alterDocToEditorHtml(doc));
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
    const parsed = parseLegacyHtml(html);
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
    const first = parseLegacyHtml(
      alterDocToEditorHtml(richDoc(), { docPath }),
    );
    const second = parseLegacyHtml(
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
    const parsed = parseLegacyHtml(html);
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
    const parsed = parseLegacyHtml(html);
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
    const parsed = parseLegacyHtml(html);
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

describe('legacy adapter: old editor syntax', () => {
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
    const parsed = parseLegacyHtml(html);
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
    const parsed = parseLegacyHtml(html, {
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
    const parsed = parseLegacyHtml(
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

describe('legacy adapter: asset materialization', () => {
  it('uploads data-URL images/files and rewrites them to asset references', async () => {
    const importAsset = vi.fn(async () => ({
      assetId: 'asset_up_img',
      mime: 'image/png',
      bytes: 3,
    }));
    const importFile = vi.fn(async () => ({
      assetId: 'asset_up_file',
      mime: 'application/pdf',
      bytes: 3,
      name: '报告.pdf',
    }));
    const html =
      '<p><img src="data:image/png;base64,AAAA" alt="图"></p>' +
      '<span data-file="报告.pdf" data-href="data:application/pdf;base64,AAAA">报告.pdf</span>';
    const materialized = await materializeLegacyAssets(html, {
      importAsset,
      importFile,
    });
    expect(materialized.warnings).toEqual([]);
    expect(importAsset).toHaveBeenCalledWith({
      mime: 'image/png',
      dataBase64: 'AAAA',
      name: '图',
    });
    expect(importFile).toHaveBeenCalledWith({
      mime: 'application/pdf',
      dataBase64: 'AAAA',
      name: '报告.pdf',
    });
    expect(materialized.html).toContain('data-asset-id="asset_up_img"');
    expect(materialized.html).toContain('data-asset-id="asset_up_file"');
    expect(materialized.html).not.toContain('data:image/png');
    const parsed = parseLegacyHtml(materialized.html);
    expect(parsed.blocks.map((item) => item.type)).toEqual([
      'image',
      'file',
    ]);
  });

  it('keeps elements and reports a warning when an upload fails', async () => {
    const materialized = await materializeLegacyAssets(
      '<p><img src="data:image/png;base64,AAAA" alt="图"></p>',
      {
        importAsset: async () => {
          throw new Error('上传失败');
        },
      },
    );
    expect(materialized.warnings.join('\n')).toContain('内联图片上传失败');
    expect(materialized.html).toContain('data:image/png');
  });

  it('reports missing upload channels without throwing', async () => {
    const materialized = await materializeLegacyAssets(
      '<p><img src="data:image/png;base64,AAAA"></p>' +
        '<span data-file="a.pdf" data-href="data:application/pdf;base64,AAAA">a</span>',
      {},
    );
    expect(materialized.warnings.join('\n')).toContain('图片上传未启用');
    expect(materialized.warnings.join('\n')).toContain('文件上传未启用');
  });
});

describe('legacy adapter: helpers', () => {
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

  it('computes a block diff for one legacy save', () => {
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
