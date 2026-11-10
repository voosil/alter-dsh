import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocVersion, SpaceService } from '@alter/protocol';
import {
  DocumentSidePanel,
  VersionPreview,
} from '../src/document/DocumentSidePanel';
import type { SpaceDocumentClient } from '../src/space-client';
import type { AlterDoc } from '../src/document/types';

const service = {} as unknown as SpaceService;
const client = {} as unknown as SpaceDocumentClient;

function version(content: string): DocVersion {
  return {
    id: 'ver_1',
    docId: 'doc-1',
    title: '版本标题',
    content,
    author: 'me',
    at: '2026-11-09T00:00:00.000Z',
  };
}

const astVersion: AlterDoc = {
  format: 'alter-doc/1',
  schemaVersion: 1,
  revision: 1,
  blocks: [
    {
      id: 'blk_p',
      type: 'paragraph',
      attrs: {},
      content: [{ type: 'text', text: '版本正文' }],
    },
  ],
};

describe('document side panel', () => {
  it('renders comment and history tabs for an AST document', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentSidePanel, {
        docId: 'doc-1',
        revision: 3,
        service,
        client,
        onRestored: () => undefined,
      }),
    );
    expect(html).toContain('评论');
    expect(html).toContain('历史');
    expect(html).toContain('还没有评论');
    expect(html).toContain('写下评论');
    expect(html).toContain('发布评论');
  });

  it('renders AST version previews through the structured renderer', () => {
    const html = renderToStaticMarkup(
      createElement(VersionPreview, {
        version: version(JSON.stringify(astVersion)),
      }),
    );
    expect(html).toContain('版本正文');
    expect(html).toContain('data-revision="1"');
    expect(html).not.toContain('旧 HTML');
  });

  it('shows a neutral message for unparseable version content', () => {
    const html = renderToStaticMarkup(
      createElement(VersionPreview, { version: version('<p>坏内容</p>') }),
    );
    expect(html).toContain('版本内容无法解析');
    expect(html).not.toContain('旧 HTML');
    expect(html).not.toContain('坏内容');
  });
});
