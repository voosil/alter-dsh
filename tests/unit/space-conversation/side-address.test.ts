/**
 * Side-chat pure helpers: resource addresses, tab titles, navigation params,
 * label copy and the selection-availability rule.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSpaceChatAddress,
  parseSpaceChatAddress,
  sideTabTitle,
  tabParamsSessionId,
} from '../../../src/space-conversation/side-tab';
import {
  SIDE_CHAT_INTERACTION_ID,
  SIDE_CHAT_TAB_KIND,
  chatRowTitle,
  chatSourceLabel,
  shortIdOf,
  sideChatAvailable,
} from '../../../src/space-conversation/side';

describe('side-chat resource address', () => {
  it('round-trips a plain session id', () => {
    const address = buildSpaceChatAddress('session-1');
    expect(address).toBe('dsh-resource://spacechat/session/session-1');
    expect(parseSpaceChatAddress(address)).toBe('session-1');
  });

  it('round-trips a session id through URI encoding', () => {
    const address = buildSpaceChatAddress('abc/def?x=1#frag');
    expect(address).toBe(
      `dsh-resource://spacechat/session/${encodeURIComponent('abc/def?x=1#frag')}`,
    );
    expect(parseSpaceChatAddress(address)).toBe('abc/def?x=1#frag');
  });

  it('rejects navigation addresses of other schemes', () => {
    expect(parseSpaceChatAddress('sidebar://alter-space.side/abc')).toBeUndefined();
    expect(parseSpaceChatAddress('dsh-resource://file/session/s1/home/a.md')).toBeUndefined();
  });

  it('rejects malformed resource addresses', () => {
    expect(parseSpaceChatAddress('not a uri')).toBeUndefined();
    expect(parseSpaceChatAddress('dsh-resource://spacechat/session/')).toBeUndefined();
    expect(parseSpaceChatAddress('dsh-resource://spacechat/session')).toBeUndefined();
    expect(parseSpaceChatAddress('dsh-resource://spacechat/session/a/b')).toBeUndefined();
    expect(parseSpaceChatAddress('dsh-resource://spacechat/other/abc')).toBeUndefined();
    // A percent sequence that never decodes is not an address we can serve.
    expect(parseSpaceChatAddress('dsh-resource://spacechat/session/%zz')).toBeUndefined();
  });
});

describe('sideTabTitle', () => {
  it('uses the session short id as the chip suffix', () => {
    expect(sideTabTitle(buildSpaceChatAddress('12345678-abcd'))).toBe(
      '侧边对话 12345678',
    );
  });

  it('keeps the generic title for an address without a session', () => {
    expect(sideTabTitle('sidebar://alter-space.side/abc')).toBe('侧边对话');
    expect(sideTabTitle('dsh-resource://spacechat/session/')).toBe('侧边对话');
  });
});

describe('tabParamsSessionId', () => {
  it('reads the branch session id from navigation params', () => {
    expect(tabParamsSessionId({ sessionId: 'child-1' })).toBe('child-1');
  });

  it('rejects absent, empty and non-string values', () => {
    expect(tabParamsSessionId(undefined)).toBeUndefined();
    expect(tabParamsSessionId(null)).toBeUndefined();
    expect(tabParamsSessionId({})).toBeUndefined();
    expect(tabParamsSessionId({ sessionId: '' })).toBeUndefined();
    expect(tabParamsSessionId({ sessionId: 42 })).toBeUndefined();
  });
});

describe('side-chat labels', () => {
  it('prefers the record title, then 侧边对话 with a short id', () => {
    expect(chatRowTitle({ title: '自定义', sessionId: 's1', id: 'c1' })).toBe('自定义');
    expect(chatRowTitle({ title: '', sessionId: 'abcdefgh-1234', id: 'c1' })).toBe(
      '侧边对话 abcdefgh',
    );
    // A record whose fork never landed has no session; the record id bridges.
    expect(chatRowTitle({ title: '', sessionId: null, id: 'rec-9' })).toBe(
      '侧边对话 rec-9',
    );
  });

  it('renders the source as a book-title or the generic main-conversation copy', () => {
    expect(chatSourceLabel({ sideOf: { sessionId: 'm', title: '主对话' } })).toBe(
      '分支自《主对话》',
    );
    // P0: the launcher records an empty source title (no reliable snapshot).
    expect(chatSourceLabel({ sideOf: { sessionId: 'm', title: '' } })).toBe(
      '分支自主对话',
    );
    expect(chatSourceLabel({ sideOf: null })).toBe('分支自主对话');
    expect(chatSourceLabel(undefined)).toBe('分支自主对话');
  });

  it('keeps a blank short id for missing ids', () => {
    expect(shortIdOf(null)).toBe('');
    expect(shortIdOf(undefined)).toBe('');
    expect(shortIdOf('abcdefgh-rest')).toBe('abcdefgh');
  });
});

describe('sideChatAvailable', () => {
  it('admits ordinary sessions', () => {
    expect(sideChatAvailable({ removed: false, subagent: null })).toBe(true);
    expect(
      sideChatAvailable({
        removed: false,
        subagent: { address: { mode: 'continuable' } },
      }),
    ).toBe(true);
  });

  it('refuses removed sessions and non-continuable subagents', () => {
    expect(sideChatAvailable({ removed: true, subagent: null })).toBe(false);
    expect(
      sideChatAvailable({
        removed: false,
        subagent: { address: { mode: 'detached' } },
      }),
    ).toBe(false);
  });
});

describe('registration constants', () => {
  it('keeps the interaction id and tab kind in sync with the spec', () => {
    expect(SIDE_CHAT_INTERACTION_ID).toBe('alter-space-sidechat');
    expect(SIDE_CHAT_TAB_KIND).toBe('alter-space.side');
  });
});
