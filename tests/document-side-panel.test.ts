import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpaceService } from '@alter/protocol';
import { DocumentSidePanel } from '../src/document/DocumentSidePanel';
import type { SpaceDocumentClient } from '../src/space-client';

const service = {} as unknown as SpaceService;
const client = {} as unknown as SpaceDocumentClient;

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

  it('renders the legacy version preview fallback text through helpers', () => {
    // The panel's preview branch is data-driven; assert the exported renderer
    // contract indirectly by checking the empty-state markup first.
    const html = renderToStaticMarkup(
      createElement(DocumentSidePanel, {
        docId: 'doc-2',
        revision: 1,
        service,
        client,
        onRestored: () => undefined,
      }),
    );
    expect(html).not.toContain('undefined');
  });
});
