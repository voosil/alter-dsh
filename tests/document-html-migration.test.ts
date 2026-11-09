import { describe, expect, it } from 'vitest';
import {
  parseLegacyHtml,
  type LegacyHtmlParserOptions,
} from '../host/document/html-migration.js';
import { validateAlterDoc } from '../host/document/schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  type BlockNode,
  type InlineNode,
} from '../host/document/types.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function parserOptions(
  assets: Record<string, string> = {},
): LegacyHtmlParserOptions {
  let counter = 0;
  return {
    createBlockId: () => {
      counter += 1;
      return `blk_test_${counter}`;
    },
    assetIdFor: (dataUrl: string) => assets[dataUrl],
  };
}

function parse(
  html: string,
  assets: Record<string, string> = {},
): BlockNode[] {
  return parseLegacyHtml(html, parserOptions(assets));
}

/** Every parse result must be a valid document body. */
function parseValid(
  html: string,
  assets: Record<string, string> = {},
): BlockNode[] {
  const blocks = parse(html, assets);
  expect(() =>
    validateAlterDoc({
      format: ALTER_DOC_FORMAT,
      schemaVersion: ALTER_DOC_SCHEMA_VERSION,
      revision: 0,
      blocks,
    }),
  ).not.toThrow();
  return blocks;
}

function textOf(content: InlineNode[] | undefined): string {
  if (content === undefined) return '';
  return content
    .map((node) => (node.type === 'text' ? node.text : '\n'))
    .join('');
}

function markTypes(node: InlineNode | undefined): string[] {
  if (node === undefined || node.type !== 'text') return [];
  return (node.marks ?? []).map((mark) => mark.type);
}

function firstText(content: InlineNode[] | undefined): InlineNode | undefined {
  return content?.find((node) => node.type === 'text');
}

describe('parseLegacyHtml blocks', () => {
  it('parses paragraphs, headings and decodes entities', () => {
    const blocks = parseValid(
      '<p>你好&nbsp;世界 &amp; &lt;tag&gt; &quot;q&quot; &#39;s&#x27;</p>' +
        '<h1>一级</h1><h2>二级</h2><h3>三级</h3><h4>四级</h4><h5>五级</h5><h6>六级</h6>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading',
      'heading',
      'heading',
      'heading',
      'heading',
      'heading',
    ]);
    expect(textOf(blocks[0]!.content)).toBe(
      '你好\u00a0世界 & <tag> "q" \'s\'',
    );
    expect(blocks.slice(1).map((block) => block.attrs.level)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('keeps empty paragraphs from <p><br></p> and empty <p>', () => {
    const blocks = parseValid('<p><br></p><p></p><p>尾</p>');
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(blocks[0]!.content ?? []).toEqual([]);
    expect(blocks[1]!.content ?? []).toEqual([]);
    expect(textOf(blocks[2]!.content)).toBe('尾');
  });

  it('maps ul/ol/li including nested lists', () => {
    const blocks = parseValid(
      '<ul><li>一</li><li>二</li></ul>' +
        '<ol start="3"><li>三<ul><li>三一</li></ul></li></ol>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'bulletList',
      'orderedList',
    ]);
    const bullet = blocks[0]!;
    expect(bullet.children?.map((item) => item.type)).toEqual([
      'listItem',
      'listItem',
    ]);
    expect(bullet.children?.[0]?.children?.[0]?.type).toBe('paragraph');
    expect(textOf(bullet.children?.[0]?.children?.[0]?.content)).toBe('一');

    const ordered = blocks[1]!;
    expect(ordered.attrs.start).toBe(3);
    const firstItem = ordered.children?.[0];
    expect(firstItem?.children?.map((child) => child.type)).toEqual([
      'paragraph',
      'bulletList',
    ]);
    const nested = firstItem?.children?.[1];
    expect(nested?.children?.[0]?.type).toBe('listItem');
    expect(textOf(nested?.children?.[0]?.children?.[0]?.content)).toBe('三一');
  });

  it('marks checked list items from data-checked and checkboxes', () => {
    const blocks = parseValid(
      '<ul><li data-checked="true">完成</li>' +
        '<li><input type="checkbox" checked>勾选</li>' +
        '<li>普通</li></ul>',
    );
    const items = blocks[0]!.children ?? [];
    expect(items.map((item) => item.attrs.checked)).toEqual([
      true,
      true,
      undefined,
    ]);
    expect(textOf(items[1]!.children?.[0]?.content)).toBe('勾选');
  });

  it('maps blockquote, pre and hr', () => {
    const blocks = parseValid(
      '<blockquote><p>引用 <strong>加粗</strong></p></blockquote>' +
        '<pre class="language-ts">const a = 1;<br>const b = 2;&lt;T&gt;</pre>' +
        '<pre><code class="language-js">let c = 3;</code></pre>' +
        '<hr>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'blockquote',
      'codeBlock',
      'codeBlock',
      'divider',
    ]);
    expect(blocks[0]!.children?.[0]?.type).toBe('paragraph');
    expect(blocks[1]!.attrs.lang).toBe('ts');
    expect(textOf(blocks[1]!.content)).toBe('const a = 1;\nconst b = 2;<T>');
    expect(blocks[2]!.attrs.lang).toBe('js');
    expect(textOf(blocks[2]!.content)).toBe('let c = 3;');
    expect(blocks[3]!.attrs).toEqual({});
  });

  it('maps tables with tableRow/tableCell and headerRows', () => {
    const blocks = parseValid(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(blocks.map((block) => block.type)).toEqual(['table']);
    const table = blocks[0]!;
    expect(table.attrs.headerRows).toBe(1);
    expect(table.children).toHaveLength(2);
    const row = table.children![1]!;
    expect(row.type).toBe('tableRow');
    expect(row.children?.map((cell) => cell.type)).toEqual([
      'tableCell',
      'tableCell',
    ]);
    expect(textOf(row.children?.[0]?.content)).toBe('1');
    expect(textOf(table.children?.[0]?.children?.[0]?.content)).toBe('A');

    const bodyOnly = parseValid('<table><tr><td>x</td></tr></table>');
    expect(bodyOnly[0]!.attrs.headerRows).toBe(0);
    const twoHeaderRows = parseValid(
      '<table><tr><th>h1</th></tr><tr><th>h2</th></tr><tr><td>v</td></tr></table>',
    );
    expect(twoHeaderRows[0]!.attrs.headerRows).toBe(2);
  });

  it('emits table captions as paragraphs after the table', () => {
    const blocks = parseValid(
      '<table><caption>说明</caption><tr><td>a</td></tr></table>',
    );
    expect(blocks.map((block) => block.type)).toEqual(['table', 'paragraph']);
    expect(textOf(blocks[1]!.content)).toBe('说明');
  });

  it('recurses transparently through divs with block children', () => {
    const blocks = parseValid(
      '<div><p>甲</p><div>乙</div><h2>丙</h2></div><div>行内</div>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'heading',
      'paragraph',
    ]);
    expect(textOf(blocks[0]!.content)).toBe('甲');
    expect(textOf(blocks[1]!.content)).toBe('乙');
    expect(blocks[2]!.attrs.level).toBe(2);
    expect(textOf(blocks[3]!.content)).toBe('行内');
  });

  it('recurses when a paragraph contains block content', () => {
    const blocks = parseValid('<div><p>前<span>中</span></p></div>');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
    expect(textOf(blocks[0]!.content)).toBe('前中');
  });
});

describe('parseLegacyHtml inline content', () => {
  it('maps inline marks and merges adjacent identical marks', () => {
    const blocks = parseValid(
      '<p><strong>粗</strong><b>体</b><em>斜</em><i>体</i>' +
        '<u>下</u><s>删</s><del>除</del><code>码</code><mark>亮</mark></p>',
    );
    const content = blocks[0]!.content ?? [];
    expect(content.map((node) => node.type)).toEqual([
      'text',
      'text',
      'text',
      'text',
      'text',
      'text',
    ]);
    expect(content.map((node) => textOf([node]))).toEqual([
      '粗体',
      '斜体',
      '下',
      '删除',
      '码',
      '亮',
    ]);
    expect(markTypes(content[0])).toEqual(['bold']);
    expect(markTypes(content[1])).toEqual(['italic']);
    expect(markTypes(content[2])).toEqual(['underline']);
    expect(markTypes(content[3])).toEqual(['strike']);
    expect(content[4]).toMatchObject({
      type: 'text',
      text: '码',
      marks: [{ type: 'code' }],
    });
    expect(content[5]).toMatchObject({
      type: 'text',
      text: '亮',
      marks: [{ type: 'highlight' }],
    });
  });

  it('keeps only safe link hrefs', () => {
    const blocks = parseValid(
      '<p><a href="https://example.com/a">示例</a> ' +
        '<a href="javascript:alert(1)">坏链</a> ' +
        '<a href="/docs/x">相对</a> <a href="mailto:a@b.c">邮件</a></p>',
    );
    const content = blocks[0]!.content ?? [];
    const links = content.filter(
      (node) =>
        node.type === 'text' &&
        node.marks?.some((mark) => mark.type === 'link') === true,
    );
    expect(links.map((node) => textOf([node]))).toEqual([
      '示例',
      '相对',
      '邮件',
    ]);
    expect(textOf(content)).toBe('示例 坏链 相对 邮件');
    const bad = content.find(
      (node) => node.type === 'text' && node.text === '坏链',
    );
    expect(markTypes(bad)).toEqual([]);
    const first = firstText(content);
    expect(first?.marks?.[0]).toMatchObject({
      type: 'link',
      attrs: { href: 'https://example.com/a' },
    });
  });

  it('maps br to hardBreak and merges text around it', () => {
    const blocks = parseValid('<p>上<br>下<br><br>再</p>');
    const content = blocks[0]!.content ?? [];
    expect(content.map((node) => node.type)).toEqual([
      'text',
      'hardBreak',
      'text',
      'hardBreak',
      'text',
    ]);
    expect(textOf(content)).toBe('上\n下\n再');
  });

  it('collapses whitespace and trims paragraph edges', () => {
    const blocks = parseValid('<p>\n  多  个\n\t空格  </p>');
    expect(textOf(blocks[0]!.content)).toBe('多 个 空格');
  });

  it('keeps unknown inline tags as text and unknown blocks transparent', () => {
    const blocks = parseValid(
      '<section><unknown-widget><strong>加粗</strong></unknown-widget></section>' +
        '<p><foo>x</foo></p>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
    expect(textOf(blocks[0]!.content)).toBe('加粗');
    expect(markTypes(blocks[0]!.content?.[0])).toEqual(['bold']);
    expect(textOf(blocks[1]!.content)).toBe('x');
  });
});

describe('parseLegacyHtml images', () => {
  it('turns resolved data-URL images into image blocks', () => {
    const blocks = parseValid(
      `<p><img src="${PNG}" alt="图" title="说明"></p>`,
      { [PNG]: 'asset_png1', [JPEG]: 'asset_jpeg1' },
    );
    expect(blocks.map((block) => block.type)).toEqual(['image']);
    expect(blocks[0]!.attrs).toMatchObject({
      assetId: 'asset_png1',
      alt: '图',
      caption: '说明',
    });

    const jpeg = parseValid(`<div><img src="${JPEG}" alt="照片"></div>`, {
      [JPEG]: 'asset_jpeg1',
    });
    expect(jpeg.map((block) => block.type)).toEqual(['image']);
    expect(jpeg[0]!.attrs.assetId).toBe('asset_jpeg1');
  });

  it('falls back to text placeholders for unresolved images', () => {
    const notImported = parseValid(`<p><img src="${PNG}" alt="图"></p>`);
    expect(notImported.map((block) => block.type)).toEqual(['paragraph']);
    expect(textOf(notImported[0]!.content)).toBe('[图片: 图]');

    const external = parseValid(
      '<p>前<img src="https://example.com/a.png" alt="外">后</p>',
    );
    expect(textOf(external[0]!.content)).toBe('前[图片: 外]后');

    const noAlt = parseValid('<p><img src="https://example.com/a.png"></p>');
    expect(textOf(noAlt[0]!.content)).toBe('[图片]');

    const svg = parseValid(
      '<p><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="向量"></p>',
    );
    expect(textOf(svg[0]!.content)).toBe('[图片: 向量]');
  });

  it('does not emit image blocks when assetIdFor returns a non-asset id', () => {
    const blocks = parseValid(`<p><img src="${PNG}"></p>`, {
      [PNG]: 'not-an-asset',
    });
    expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
    expect(textOf(blocks[0]!.content)).toBe('[图片]');
  });
});

describe('parseLegacyHtml file chips and link cards', () => {
  it('renders file chips as text and links', () => {
    const blocks = parseValid(
      '<p><span data-file="report.pdf">季度报告.pdf</span></p>' +
        '<p><span data-file="/files/a.pdf" data-name="方案.pdf"></span></p>' +
        '<p><span data-file="file_123"></span></p>' +
        '<p><span data-file="https://example.com/f.pdf">下载</span></p>',
    );
    expect(blocks.map((block) => textOf(block.content))).toEqual([
      '季度报告.pdf',
      '方案.pdf',
      '[文件: file_123]',
      '下载',
    ]);
    const linked = firstText(blocks[3]!.content);
    expect(linked?.marks?.[0]).toMatchObject({
      type: 'link',
      attrs: { href: 'https://example.com/f.pdf' },
    });
  });

  it('renders link cards as link marks or placeholder text', () => {
    const blocks = parseValid(
      '<div data-link-card data-href="https://example.com/card" data-title="卡片"></div>' +
        '<p><span data-link-card data-href="https://example.com/x">站外</span></p>' +
        '<p><span data-link-card data-href="javascript:void(0)">危险</span></p>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(textOf(blocks[0]!.content)).toBe('卡片');
    expect(firstText(blocks[0]!.content)?.marks?.[0]).toMatchObject({
      type: 'link',
      attrs: { href: 'https://example.com/card' },
    });
    expect(textOf(blocks[1]!.content)).toBe('站外');
    expect(markTypes(firstText(blocks[1]!.content))).toEqual(['link']);
    expect(textOf(blocks[2]!.content)).toBe('危险');
    expect(markTypes(firstText(blocks[2]!.content))).toEqual([]);
  });
});

describe('parseLegacyHtml robustness', () => {
  it('returns no blocks for empty or comment-only input', () => {
    expect(parseValid('')).toEqual([]);
    expect(parseValid('   \n\t  ')).toEqual([]);
    expect(parseValid('<!-- 只有注释 -->')).toEqual([]);
    expect(parseValid('<!DOCTYPE html><html><head><title>t</title></head><body></body></html>')).toEqual([]);
  });

  it('tolerates malformed markup without throwing', () => {
    const inputs = [
      '<p>未闭合',
      '<div><p>甲<p>乙',
      '</p></div><td>孤立单元格</td>',
      '<<<>>>',
      '<p>a<b>b</p>',
      '< ul><li>x',
      '<pre>未闭合的代码',
      '&unknown; & &amp &#xZZ;',
      '<table><tr><td>x',
      '<a href="x">链接',
      '<p class="broken>引号未闭合</p>',
      '<img src="' + PNG,
      '</ >',
    ];
    for (const html of inputs) {
      expect(() => parse(html)).not.toThrow();
      parseValid(html);
    }
  });

  it('flattens absurdly deep nesting to a valid document', () => {
    const deep = `${'<blockquote>'.repeat(120)}深${'</blockquote>'.repeat(120)}`;
    const blocks = parseValid(deep);
    expect(blocks.length).toBeGreaterThan(0);
    const nestedDivs = `${'<div>'.repeat(500)}宽${'</div>'.repeat(500)}`;
    expect(() => parseValid(nestedDivs)).not.toThrow();
  });

  it('truncates huge input instead of emitting an invalid document', () => {
    const many = parseValid('<p>行</p>'.repeat(4_000));
    expect(many.length).toBeGreaterThan(0);
    expect(many.length).toBeLessThanOrEqual(5_000);

    const huge = parseValid(`<p>${'长'.repeat(700_000)}</p>`);
    expect(huge.length).toBeGreaterThan(0);
    const last = huge[huge.length - 1]!;
    expect(textOf(last.content)).toContain('截断');
  });

  it('keeps block ids unique across the whole tree', () => {
    const blocks = parseValid(
      '<h1>t</h1><p>p</p><ul><li>a<ul><li>b</li></ul></li></ul>' +
        '<table><tr><th>h</th></tr><tr><td>c</td></tr></table>',
    );
    const ids: string[] = [];
    const walk = (nodes: BlockNode[]): void => {
      for (const node of nodes) {
        ids.push(node.id);
        walk(node.children ?? []);
      }
    };
    walk(blocks);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
