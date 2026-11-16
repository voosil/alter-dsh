// @vitest-environment jsdom
/**
 * SpaceRefCard interaction contract.
 *
 * P0: an interactive card is a button that opens its target in the right
 * sidebar through the Space bridge — the page tab for a page, the space entry
 * (`nodeId: null`) for a space.
 */
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSpaceBridge, type SpaceBridge } from '../../../src/integration/bridge';
import {
  SPACE_REF_ARCHIVED_HINT,
  SPACE_REF_MISSING_HINT,
  SpaceRefCard,
  setSpaceRefPreviewResolver,
  setSpaceRefStateResolver,
  type SpaceRefData,
  type SpaceRefNode,
} from '../../../src/space-conversation/cards';

function nodeOf(data: SpaceRefData): SpaceRefNode {
  return { id: 'space-ref', start: 0, end: data.raw.length, data };
}

const PAGE_NODE = nodeOf({
  kind: 'page',
  spaceId: 'alpha',
  nodeId: 'n-01',
  label: 'n-01',
  raw: 'dsh-space://space/alpha/page/n-01',
});

const SPACE_NODE = nodeOf({
  kind: 'space',
  spaceId: 'beta',
  nodeId: null,
  label: 'beta',
  raw: 'dsh-space://space/beta',
});

/** Bridge double with recorded capabilities; tests swap in their own openPageInRightbar. */
function bridgeFake(): SpaceBridge {
  return {
    toggleRightbar: vi.fn(),
    startPageChat: vi.fn(() => Promise.reject(new Error('unused in this suite'))),
    relatedChats: vi.fn(() => Promise.resolve([])),
    openPageInRightbar: vi.fn(),
    openChat: vi.fn(),
    deleteChat: vi.fn(() => Promise.resolve()),
  };
}

afterEach(() => {
  cleanup();
  setSpaceBridge(null);
  setSpaceRefStateResolver(null);
  setSpaceRefPreviewResolver(null);
});

describe('SpaceRefCard', () => {
  it('renders an interactive page card as a button that opens the rightbar', () => {
    const open = vi.fn();
    setSpaceBridge({ ...bridgeFake(), openPageInRightbar: open });
    const { container } = render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    expect(container.querySelector('svg.lucide-file-text')).not.toBeNull();
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('n-01');
    expect(button.textContent).toContain('页面');
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ spaceId: 'alpha', nodeId: 'n-01' });
  });

  it('renders a space card that opens the space entry', () => {
    const open = vi.fn();
    setSpaceBridge({ ...bridgeFake(), openPageInRightbar: open });
    const { container } = render(
      createElement(SpaceRefCard, {
        node: SPACE_NODE,
        interactive: true,
        raw: SPACE_NODE.data.raw,
      }),
    );
    expect(container.querySelector('svg.lucide-orbit')).not.toBeNull();
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('beta');
    expect(button.textContent).toContain('空间');
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith({ spaceId: 'beta', nodeId: null });
  });

  it('copies the original link when the card itself is copied', () => {
    setSpaceBridge(bridgeFake());
    render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const setData = vi.fn();
    const event = createEvent.copy(screen.getByRole('button'));
    Object.defineProperty(event, 'clipboardData', { value: { setData } });
    fireEvent(screen.getByRole('button'), event);
    expect(setData).toHaveBeenCalledWith('text/plain', PAGE_NODE.data.raw);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a sentence copy alone (the card is not selectable)', () => {
    setSpaceBridge(bridgeFake());
    render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const setData = vi.fn();
    const event = createEvent.copy(screen.getByRole('button'));
    Object.defineProperty(event, 'clipboardData', { value: { setData } });
    // Simulate a sentence selection that merely ends on the card.
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => '看 dsh-space://space/alpha/page/n-01 这段' } as never);
    fireEvent(screen.getByRole('button'), event);
    expect(setData).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    selection.mockRestore();
  });

  it('shows a hover preview once per card instance', async () => {
    setSpaceBridge(bridgeFake());
    const preview = vi.fn(async () => ({
      title: '多智能体协作调研',
      spaceName: '调研空间',
      updatedAt: new Date().toISOString(),
    }));
    setSpaceRefPreviewResolver(preview);
    render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeDefined());
    expect(screen.getByRole('tooltip').textContent).toContain('多智能体协作调研');
    expect(screen.getByRole('tooltip').textContent).toContain('调研空间');
    // 第二次悬停复用同一份结果，不重复请求。
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(button);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeDefined());
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('shows no preview when the lookup fails and retries next hover', async () => {
    setSpaceBridge(bridgeFake());
    const preview = vi.fn(async () => Promise.reject(new Error('rpc down')));
    setSpaceRefPreviewResolver(preview);
    render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(button);
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  });

  it('does not look up a preview for a missing reference', () => {
    setSpaceBridge(bridgeFake());
    setSpaceRefStateResolver(() => 'missing');
    const preview = vi.fn(async () => ({ title: '不应该出现' }));
    setSpaceRefPreviewResolver(preview);
    const { container } = render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const card = container.firstElementChild;
    if (card !== null) fireEvent.mouseEnter(card);
    expect(preview).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps both cards inert when the message is not interactive', () => {
    const open = vi.fn();
    setSpaceBridge({ ...bridgeFake(), openPageInRightbar: open });
    for (const node of [PAGE_NODE, SPACE_NODE]) {
      const { container, unmount } = render(
        createElement(SpaceRefCard, {
          node,
          interactive: false,
          raw: node.data.raw,
        }),
      );
      expect(screen.queryByRole('button')).toBeNull();
      const card = container.firstElementChild;
      expect(card?.tagName).toBe('SPAN');
      if (card !== null) fireEvent.click(card);
      unmount();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('greys a missing card, keeps the text and does not navigate', () => {
    const open = vi.fn();
    setSpaceBridge({ ...bridgeFake(), openPageInRightbar: open });
    setSpaceRefStateResolver(() => 'missing');
    const { container } = render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    expect(screen.queryByRole('button')).toBeNull();
    const card = container.firstElementChild;
    expect(card?.getAttribute('data-state')).toBe('missing');
    expect(card?.getAttribute('title')).toContain(SPACE_REF_MISSING_HINT);
    expect(card?.textContent).toContain('n-01');
    if (card !== null) fireEvent.click(card);
    expect(open).not.toHaveBeenCalled();
  });

  it('greys an archived card but still opens it', () => {
    const open = vi.fn();
    setSpaceBridge({ ...bridgeFake(), openPageInRightbar: open });
    setSpaceRefStateResolver(() => 'archived');
    const { container } = render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('data-state')).toBe('archived');
    expect(button.getAttribute('title')).toContain(SPACE_REF_ARCHIVED_HINT);
    expect(container.querySelector('[data-state="archived"]')).not.toBeNull();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith({ spaceId: 'alpha', nodeId: 'n-01' });
  });

  it('keeps a page card inert when the message is not interactive', () => {
    const open = vi.fn();
    setSpaceBridge({ ...bridgeFake(), openPageInRightbar: open });
    const { container } = render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: false,
        raw: PAGE_NODE.data.raw,
      }),
    );
    expect(screen.queryByRole('button')).toBeNull();
    const card = container.firstElementChild;
    expect(card?.tagName).toBe('SPAN');
    if (card !== null) fireEvent.click(card);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not throw when the bridge is absent', () => {
    setSpaceBridge(null);
    const { container } = render(
      createElement(SpaceRefCard, {
        node: PAGE_NODE,
        interactive: true,
        raw: PAGE_NODE.data.raw,
      }),
    );
    const button = screen.getByRole('button');
    expect(() => fireEvent.click(button)).not.toThrow();
    expect(container.querySelector('button')).not.toBeNull();
  });
});
