/**
 * History-row pure helpers: relative time formatting and quote fragments.
 * All expectations are built with local-time arithmetic so the suite holds in
 * any time zone.
 */
import { describe, expect, it } from 'vitest';
import {
  filterSideChats,
  formatRelativeTime,
  groupSideChats,
  quoteFragment,
} from '../../../src/space-conversation/side-history';
import type { Chat } from '../../../vendor/protocol/src/index';

/** One side-chat record with the fields the toolbar reads. */
function chat(
  id: string,
  overrides: Partial<Chat> = {},
): Chat {
  return {
    id,
    kind: 'side',
    sessionId: `session-${id}`,
    title: '',
    sideOf: { sessionId: 'main-1', title: '主对话' },
    refs: [],
    quote: null,
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

/** Local date at midnight of `daysBefore` days before `now`. */
function localDaysBefore(now: number, daysBefore: number): Date {
  const date = new Date(now);
  date.setDate(date.getDate() - daysBefore);
  date.setHours(0, 0, 0, 0);
  return date;
}

describe('formatRelativeTime', () => {
  const now = new Date(2026, 10, 13, 18, 30, 15).getTime();

  it('renders 刚刚 under a minute, including future timestamps', () => {
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe('刚刚');
    expect(formatRelativeTime(new Date(now).toISOString(), now)).toBe('刚刚');
    expect(formatRelativeTime(new Date(now + 120_000).toISOString(), now)).toBe('刚刚');
  });

  it('renders N 分钟前 under an hour', () => {
    expect(formatRelativeTime(new Date(now - 60_000).toISOString(), now)).toBe('1 分钟前');
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe(
      '5 分钟前',
    );
    expect(formatRelativeTime(new Date(now - 59 * 60_000).toISOString(), now)).toBe(
      '59 分钟前',
    );
  });

  it('renders today as HH:mm', () => {
    const morning = new Date(2026, 10, 13, 9, 5).getTime();
    expect(formatRelativeTime(new Date(morning).toISOString(), now)).toBe('09:05');
  });

  it('renders yesterday as 昨天', () => {
    const then = localDaysBefore(now, 1);
    then.setHours(22, 41);
    expect(formatRelativeTime(new Date(then.getTime()).toISOString(), now)).toBe('昨天');
  });

  it('renders older dates as MM-DD', () => {
    const then = localDaysBefore(now, 3);
    expect(formatRelativeTime(new Date(then.getTime()).toISOString(), now)).toBe(
      '11-10',
    );
    const october = new Date(2026, 9, 4, 12, 0).getTime();
    expect(formatRelativeTime(new Date(october).toISOString(), now)).toBe('10-04');
  });

  it('renders unparseable timestamps as empty', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});

describe('quoteFragment', () => {
  it('passes short quotes through with whitespace collapsed', () => {
    expect(quoteFragment('单行引用')).toBe('单行引用');
    expect(quoteFragment('  a \n\t b  ')).toBe('a b');
  });

  it('renders blank quotes as nothing', () => {
    expect(quoteFragment(null)).toBeNull();
    expect(quoteFragment('')).toBeNull();
    expect(quoteFragment('   \n\t ')).toBeNull();
  });

  it('keeps a quote of exactly the cap intact', () => {
    const quote = '字'.repeat(60);
    expect(quoteFragment(quote)).toBe(quote);
  });

  it('cuts longer quotes at the cap and appends an ellipsis', () => {
    const quote = '字'.repeat(61);
    expect(quoteFragment(quote)).toBe(`${'字'.repeat(60)}…`);
    expect(quoteFragment('x'.repeat(120), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('counts code points, not UTF-16 units', () => {
    const quote = `𝄞${'a'.repeat(60)}`;
    expect(quoteFragment(quote, 3)).toBe('𝄞aa…');
  });
});

describe('filterSideChats（P1 搜索）', () => {
  const rows = [
    chat('a', { title: '三种协作模式', quote: '多智能体的协作模式可以分成……' }),
    chat('b', { title: '权限模型', sideOf: { sessionId: 'main-2', title: '方案评审' } }),
    chat('c', { title: '无标题记录', quote: null }),
  ];

  it('matches title, quote and stored source title, case-insensitively', () => {
    expect(filterSideChats(rows, '协作').map((row) => row.id)).toEqual(['a']);
    expect(filterSideChats(rows, '智能体').map((row) => row.id)).toEqual(['a']);
    expect(filterSideChats(rows, '方案评审').map((row) => row.id)).toEqual(['b']);
    expect(filterSideChats(rows, '  权限  ').map((row) => row.id)).toEqual(['b']);
  });

  it('keeps every row for a blank query', () => {
    expect(filterSideChats(rows, '')).toBe(rows);
    expect(filterSideChats(rows, '   ')).toBe(rows);
  });

  it('returns nothing when no row matches', () => {
    expect(filterSideChats(rows, '不存在')).toEqual([]);
  });
});

describe('groupSideChats（P1 按来源分组）', () => {
  it('groups by source in first-seen (newest activity) order', () => {
    const rows = [
      chat('a', { sideOf: { sessionId: 'main-1', title: '方案评审' } }),
      chat('b', { sideOf: { sessionId: 'main-2', title: '权限讨论' } }),
      chat('c', { sideOf: { sessionId: 'main-1', title: '方案评审' } }),
    ];
    const groups = groupSideChats(rows);
    expect(groups.map((group) => group.key)).toEqual(['main-1', 'main-2']);
    expect(groups.map((group) => group.label)).toEqual(['来源：方案评审', '来源：权限讨论']);
    expect(groups[0]?.chats.map((row) => row.id)).toEqual(['a', 'c']);
    expect(groups[1]?.chats.map((row) => row.id)).toEqual(['b']);
  });

  it('labels a gone source and a record without a source', () => {
    const rows = [
      chat('a', { sideOf: { sessionId: 'main-9', title: '已删除的对话' } }),
      chat('b', { sideOf: null }),
      chat('c', { sideOf: { sessionId: 'main-3', title: '' } }),
    ];
    const groups = groupSideChats(rows, new Set(['main-9']));
    expect(groups.map((group) => group.label)).toEqual([
      '来源已删除',
      '未记录来源',
      '来源：无标题',
    ]);
  });
});
