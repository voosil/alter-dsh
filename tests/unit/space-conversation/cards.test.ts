/**
 * Space link → reference-card matching.
 *
 * Drives `spaceRefRule` exactly the way the conversation factory does:
 * repeated synchronous `match(text, from)` calls, advancing `from` to each
 * accepted node's end until the rule declines. The link grammar itself lives
 * in `src/chat/parse.ts`; it is pinned here through the rule's spans.
 */
import { describe, expect, it } from 'vitest';
import { findSpaceLink } from '../../../src/chat/parse';
import {
  SPACE_REF_ID,
  SPACE_REF_ORDER,
  spaceRefRule,
  type SpaceRefNode,
} from '../../../src/space-conversation/cards';

/** Walk a text like the factory: match from 0, advance to each node's end. */
function collect(text: string): SpaceRefNode[] {
  const nodes: SpaceRefNode[] = [];
  let from = 0;
  for (;;) {
    const node = spaceRefRule.match(text, from, undefined);
    if (node === undefined) break;
    if (node.id === 'text') {
      throw new Error(`space-ref rule must not emit text replacements (${node.start}…${node.end})`);
    }
    expect(node.end).toBeGreaterThan(node.start);
    expect(node.end).toBeLessThanOrEqual(text.length);
    nodes.push(node);
    from = node.end;
  }
  return nodes;
}

const RAW_SPACE = 'dsh-space://space/alpha';
const RAW_PAGE = 'dsh-space://space/alpha/page/n-01';
const RAW_ROUTER_SPACE = '#/space/beta';
const RAW_ROUTER_PAGE = '#/space/beta/doc/n-02';

describe('space link grammar (findSpaceLink contract)', () => {
  it('matches the canonical dsh-space forms', () => {
    expect(findSpaceLink(`见 ${RAW_SPACE} 与后文`)).toEqual({
      ref: { kind: 'space', spaceId: 'alpha', nodeId: null },
      start: 2,
      end: 2 + RAW_SPACE.length,
      raw: RAW_SPACE,
    });
    expect(findSpaceLink(RAW_PAGE)).toEqual({
      ref: { kind: 'page', spaceId: 'alpha', nodeId: 'n-01' },
      start: 0,
      end: RAW_PAGE.length,
      raw: RAW_PAGE,
    });
  });

  it('matches the in-app router forms', () => {
    expect(findSpaceLink(RAW_ROUTER_SPACE)).toEqual({
      ref: { kind: 'space', spaceId: 'beta', nodeId: null },
      start: 0,
      end: RAW_ROUTER_SPACE.length,
      raw: RAW_ROUTER_SPACE,
    });
    expect(findSpaceLink(RAW_ROUTER_PAGE)).toEqual({
      ref: { kind: 'page', spaceId: 'beta', nodeId: 'n-02' },
      start: 0,
      end: RAW_ROUTER_PAGE.length,
      raw: RAW_ROUTER_PAGE,
    });
  });

  it('finds the first candidate at or after `from`', () => {
    const text = `${RAW_SPACE} 中段 ${RAW_ROUTER_PAGE}`;
    const mid = RAW_SPACE.length + 1;
    const found = findSpaceLink(text, mid);
    expect(found?.start).toBe(text.indexOf(RAW_ROUTER_PAGE));
    expect(findSpaceLink(text, text.length)).toBeNull();
  });
});

describe('spaceRefRule', () => {
  it('declares the fixed id and factory order', () => {
    expect(spaceRefRule.id).toBe(SPACE_REF_ID);
    expect(spaceRefRule.order).toBe(SPACE_REF_ORDER);
    expect(SPACE_REF_ORDER).toBe(100);
  });

  it('is pure and stateless', () => {
    const text = `前 ${RAW_PAGE} 后`;
    expect(spaceRefRule.match(text, 0, undefined)).toEqual(
      spaceRefRule.match(text, 0, undefined),
    );
  });

  it('declines text without Space links, including plain URLs', () => {
    expect(collect('普通文本，没有链接')).toEqual([]);
    expect(collect('https://example.com/docs/page 和 https://example.com/x')).toEqual([]);
  });

  it('matches mixed text with the exact spans and payloads', () => {
    const text = `前文页面 ${RAW_PAGE} 与空间 ${RAW_ROUTER_SPACE}，参考 https://example.com/docs 不是链接，而 ${RAW_ROUTER_PAGE} 也是页面。`;
    const nodes = collect(text);
    expect(nodes).toHaveLength(3);

    const [first, second, third] = nodes;
    expect(first.start).toBe(text.indexOf(RAW_PAGE));
    expect(text.slice(first.start, first.end)).toBe(RAW_PAGE);
    expect(first.data).toEqual({
      kind: 'page',
      spaceId: 'alpha',
      nodeId: 'n-01',
      label: 'n-01',
      raw: RAW_PAGE,
    });

    expect(second.start).toBe(text.indexOf(RAW_ROUTER_SPACE));
    expect(text.slice(second.start, second.end)).toBe(RAW_ROUTER_SPACE);
    expect(second.data).toEqual({
      kind: 'space',
      spaceId: 'beta',
      nodeId: null,
      label: 'beta',
      raw: RAW_ROUTER_SPACE,
    });

    expect(third.start).toBe(text.indexOf(RAW_ROUTER_PAGE));
    expect(text.slice(third.start, third.end)).toBe(RAW_ROUTER_PAGE);
    expect(third.data).toEqual({
      kind: 'page',
      spaceId: 'beta',
      nodeId: 'n-02',
      label: 'n-02',
      raw: RAW_ROUTER_PAGE,
    });

    // The non-link URL and the surrounding Chinese stay outside every node.
    for (const node of nodes) {
      const slice = text.slice(node.start, node.end);
      expect(slice).not.toContain('example.com');
      expect(slice).not.toContain('前文');
      expect(slice).not.toContain('也是页面');
    }
  });

  it('keeps one atomic node per link across id charset variants', () => {
    const text = 'dsh-space://space/ws_2/page/n_9 结束';
    const [node] = collect(text);
    expect(node.data).toEqual({
      kind: 'page',
      spaceId: 'ws_2',
      nodeId: 'n_9',
      label: 'n_9',
      raw: 'dsh-space://space/ws_2/page/n_9',
    });
    expect(text.slice(node.start, node.end)).toBe('dsh-space://space/ws_2/page/n_9');
  });

  it('returns the first candidate at or after `from`, never an earlier one', () => {
    const text = `${RAW_SPACE} 和 ${RAW_ROUTER_PAGE}`;
    const second = spaceRefRule.match(text, RAW_SPACE.length + 1, undefined);
    expect(second).not.toBeUndefined();
    if (second !== undefined && second.id !== 'text') {
      expect(second.data.raw).toBe(RAW_ROUTER_PAGE);
    }
    expect(spaceRefRule.match(text, text.length, undefined)).toBeUndefined();
  });

  it('splits adjacent links into back-to-back nodes without overlap or duplication', () => {
    const text = `${RAW_SPACE}${RAW_ROUTER_SPACE}`;
    const nodes = collect(text);
    expect(nodes).toHaveLength(2);
    const [first, second] = nodes;
    expect(first.data.raw).toBe(RAW_SPACE);
    expect(second.data.raw).toBe(RAW_ROUTER_SPACE);
    expect(second.start).toBe(first.end);

    const adjacentPages = `${RAW_PAGE}${RAW_ROUTER_PAGE}`;
    const [pageFirst, pageSecond] = collect(adjacentPages);
    expect(pageFirst.data.kind).toBe('page');
    expect(pageFirst.data.raw).toBe(RAW_PAGE);
    expect(pageSecond.start).toBe(pageFirst.end);
    expect(pageSecond.data.raw).toBe(RAW_ROUTER_PAGE);
    expect(collect(adjacentPages.slice(pageSecond.end))).toEqual([]);
  });

  it('emits JSON-serializable data', () => {
    const [node] = collect(RAW_PAGE);
    const revived = JSON.parse(JSON.stringify(node)) as SpaceRefNode;
    expect(revived).toEqual(node);
  });
});
