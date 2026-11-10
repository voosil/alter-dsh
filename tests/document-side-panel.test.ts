// @vitest-environment jsdom
/**
 * Document side panel: comments tab rendering (unchanged) and the history tab
 * now mounting the AST diff/restore view.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocVersion, SpaceService } from '@alter/protocol';
import { DocumentSidePanel } from '../src/document/DocumentSidePanel';
import type { SpaceDocumentClient } from '../src/space-client';
import type { AlterDoc } from '../src/document/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const service = {} as unknown as SpaceService;
const client = {} as unknown as SpaceDocumentClient;

const astDoc: AlterDoc = {
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

function version(
  id: string,
  doc: AlterDoc,
  title: string,
  author: 'me' | 'alter',
): DocVersion {
  return {
    id,
    docId: 'doc-1',
    title,
    content: JSON.stringify(doc),
    author,
    at: '2026-11-09T00:00:00.000Z',
  };
}

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

  it('switches to the history tab and mounts the version diff view', async () => {
    const older = version('ver-1', astDoc, '旧标题', 'me');
    const newerDoc: AlterDoc = {
      ...astDoc,
      blocks: [
        ...astDoc.blocks,
        {
          id: 'blk_new',
          type: 'paragraph',
          attrs: {},
          content: [{ type: 'text', text: '新增正文' }],
        },
      ],
    };
    const newer = version('ver-2', newerDoc, '新标题', 'alter');
    const historyService = {
      listComments: vi.fn(async () => []),
      listVersions: vi.fn(async () => [newer, older]),
    } as unknown as SpaceService;
    const historyClient = {
      get: vi.fn(async () => ({
        docId: 'doc-1',
        revision: 2,
        title: '当前标题',
        doc: {
          ...astDoc,
          blocks: [
            {
              id: 'blk_current',
              type: 'paragraph',
              attrs: {},
              content: [{ type: 'text', text: '当前正文' }],
            },
          ],
        },
      })),
      restoreVersion: vi.fn(async () => ({ docId: 'doc-1', revision: 3 })),
    } as unknown as SpaceDocumentClient;

    render(
      createElement(DocumentSidePanel, {
        docId: 'doc-1',
        revision: 2,
        service: historyService,
        client: historyClient,
        onRestored: () => undefined,
      }),
    );

    await waitFor(() => expect(screen.getByText('还没有评论。')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /历史/ }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '恢复此版本' })).toBeTruthy(),
    );
    const versionList = screen.getByRole('list', { name: '版本列表' });
    expect(versionList.textContent).toContain('Alter');
    expect(versionList.textContent).toContain('我');
    expect(screen.getByText('新增 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /评论/ }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText('写下评论…')).toBeTruthy(),
    );
  });
});
