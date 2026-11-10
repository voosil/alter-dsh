import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentContent } from '../src/document/DocumentContent';
import type { AlterDoc, BlockNode } from '../src/document/types';

function block(
  id: string,
  type: string,
  attrs: BlockNode['attrs'] = {},
  extra: Partial<BlockNode> = {},
): BlockNode {
  return { id, type, attrs, ...extra };
}

const doc: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 3,
  blocks: [
    block('blk_h', 'heading', { level: 1 }, {
      content: [{ type: 'text', text: '鉴权方案' }],
    }),
    block('blk_p', 'paragraph', {}, {
      content: [
        { type: 'text', text: '先做 ' },
        { type: 'text', text: 'P0', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' 与 ' },
        { type: 'text', text: '文档', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
      ],
    }),
    block('blk_c', 'callout', { tone: 'warn', title: '注意' }, {
      children: [
        block('blk_cp', 'paragraph', {}, {
          content: [{ type: 'text', text: '高亮块正文' }],
        }),
      ],
    }),
    block('blk_code', 'codeBlock', { lang: 'ts' }, {
      content: [{ type: 'text', text: 'const answer = 42;' }],
    }),
    block('blk_t', 'table', { headerRows: 1 }, {
      children: [
        block('blk_r1', 'tableRow', {}, {
          children: [
            block('blk_c1', 'tableCell', {}, { content: [{ type: 'text', text: '列1' }] }),
            block('blk_c2', 'tableCell', {}, { content: [{ type: 'text', text: '列2' }] }),
          ],
        }),
      ],
    }),
    block('blk_img', 'image', { assetId: 'asset_demo', alt: '架构图' }),
    block('blk_file', 'file', {
      assetId: 'asset_file',
      name: '需求说明.pdf',
      mime: 'application/pdf',
      bytes: 2048,
    }),
    block('blk_map', 'mindmap', { objectId: 'obj_demo', caption: '流程' }),
    block('blk_cmp', 'component', { objectId: 'obj_chart', title: '图表' }),
    block('blk_link', 'bookmark', {
      url: 'https://example.com/guide',
      title: '外部指南',
      description: '背景资料',
      icon: '📚',
    }),
    block('blk_doc_link', 'docLink', {
      docId: 'doc-related',
      title: '相关文档',
    }),
    block('blk_unknown', 'mystery'),
  ],
};

describe('Alter document renderer', () => {
  it('renders the v0 block set without raw JSON', () => {
    const html = renderToStaticMarkup(createElement(DocumentContent, { doc }));
    expect(html).toContain('data-revision="3"');
    expect(html).toContain('鉴权方案');
    expect(html).toContain('<strong>P0</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain('高亮块正文');
    expect(html).toContain('const answer = 42;');
    expect(html).toContain('列1');
    expect(html).toContain('架构图');
    expect(html).toContain('asset_demo');
    expect(html).toContain('data-card-kind="file"');
    expect(html).toContain('需求说明.pdf');
    expect(html).toContain('application/pdf');
    expect(html).toContain('2.0 KB');
    expect(html).toContain(
      'href="/api/alter-space/asset?id=asset_file"',
    );
    expect(html).toContain('download="需求说明.pdf"');
    expect(html).toContain('obj_demo');
    expect(html).toContain('obj_chart');
    expect(html).toContain('外部指南');
    expect(html).toContain('背景资料');
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('相关文档');
    expect(html).toContain('doc-related');
    expect(html).toContain('[unsupported node: mystery]');
    expect(html).not.toContain('{"format":"alter-doc/1"');
  });

  it('drops unsafe link targets and renders no anchor', () => {
    const unsafe: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: 1,
      blocks: [
        block('blk_p', 'paragraph', {}, {
          content: [
            {
              type: 'text',
              text: '坏链接',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        }),
        block('blk_bad_card', 'bookmark', {
          url: 'javascript:alert(1)',
          title: '坏卡片',
        }),
      ],
    };
    const html = renderToStaticMarkup(createElement(DocumentContent, { doc: unsafe }));
    expect(html).toContain('坏链接');
    expect(html).toContain('坏卡片');
    // Unsafe targets may show as plain text, but never become anchors.
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<a');
  });
});
