/**
 * Thought body rendering must not execute stored HTML.
 *
 * Thoughts are stored as the composer's rich-text HTML, but the string is
 * written by any authority client — including an Agent through
 * `space.createThought` — and rendered with `dangerouslySetInnerHTML`. The row
 * therefore sanitizes on render: only the tags the composer can produce
 * survive, and event handlers, scripts and non-web URLs never reach the DOM.
 */
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Thought } from '@alter/protocol';
import { ThoughtRow } from '../../../vendor/ui-space/src/components/ThoughtRow';

function thought(content: string): Thought {
  return {
    id: 'th-1',
    spaceId: 'sp-1',
    content,
    creator: 'alter',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    archived: false,
    archivedAt: null,
    deletedAt: null,
    convertedDocId: null,
  } as Thought;
}

function renderContent(content: string): HTMLElement {
  const { container } = render(
    createElement(ThoughtRow, {
      thought: thought(content),
      onOpen: () => undefined,
      onEdit: () => undefined,
      onToggleArchive: () => undefined,
      onMenu: () => undefined,
    }),
  );
  return container;
}

describe('thought body sanitization', () => {
  it('strips scripts and event handlers written by another client', () => {
    const container = renderContent(
      '<p>正文<img src="x" onerror="alert(1)"></p><script>alert(2)</script>',
    );
    const html = container.innerHTML;
    expect(html).toContain('正文');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(container.querySelector('script')).toBeNull();
  });

  it('drops script/style wrappers but keeps the text they surrounded', () => {
    const container = renderContent(
      '<style>body{display:none}</style><span>保留</span>',
    );
    expect(container.querySelector('style')).toBeNull();
    expect(container.textContent).toContain('保留');
  });

  it('keeps the composer markup, including safe links', () => {
    const container = renderContent(
      '<p><strong>加粗</strong> <a href="https://example.com">链接</a></p>',
    );
    expect(container.innerHTML).toContain('<strong>加粗</strong>');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
  });

  it('drops javascript: and style attributes', () => {
    const container = renderContent(
      '<a href="javascript:alert(1)" style="display:none">x</a>',
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBeNull();
    expect(link?.getAttribute('style')).toBeNull();
  });
});