// @vitest-environment jsdom
/**
 * 空间/页面引用 chip 与引用条（`src/space-conversation/refs.ts`）。
 *
 * 三层固定：纯逻辑（key/link 往返、去重与上限、粘贴转换的多链接与 caret 边界、
 * chip 的 detect 坐标换算）、DSH 结构面（`space-ref` 触发源只提供 codec、chip
 * 插入走会话作用域 `slash/input-insert-reference`）、注册生命周期（一个 cleanup
 * 拆掉引用条与 codec；chip 通路缺 codec 时绝不插 chip）。最后一段在 jsdom 里
 * 渲染引用条本身：空态、chip、× 删除与上限提示。
 *
 * 与已发送消息的卡片共用同一个引用来源名：这里直接断言
 * `SPACE_REF_SOURCE === SPACE_REF_ID`，两边漂移即失败。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPACE_REF_ID } from '../../../src/space-conversation/cards';
import { setSpaceBridge } from '../../../src/integration/bridge';
import {
  SPACE_REF_DOCK_ID,
  SPACE_REF_DOCK_LABEL,
  SPACE_REF_DOCK_ORDER,
  SPACE_REF_DOCK_SLOT,
  SPACE_REF_EMPTY_TEXT,
  SPACE_REF_INSERT_EVENT,
  SPACE_REF_ADD_LABEL,
  SPACE_REF_LIMIT,
  SPACE_REF_LIMIT_TEXT,
  SPACE_REF_PICK_FAILED,
  SPACE_REF_PICK_TEXT,
  SPACE_REF_REMOVED_TEXT,
  SPACE_REF_SOURCE,
  SPACE_REF_UNRECOGNIZED_TEXT,
  SpaceRefDock,
  autoReferenceSession,
  insertSpaceRefChip,
  mergeRefs,
  parseSpaceRefKey,
  pasteRefsToDraft,
  refsInDraft,
  registerSpaceRefComposer,
  spaceRefDefaultLabel,
  spaceRefIdentity,
  spaceRefInsert,
  spaceRefKey,
  spaceRefLink,
  spaceRefPlaceholderText,
  toDetectSpan,
  uncoveredRefInDraft,
} from '../../../src/space-conversation/refs';

const SPACE: { kind: 'space'; spaceId: string; nodeId: null } = {
  kind: 'space',
  spaceId: 'alpha',
  nodeId: null,
};
const PAGE: { kind: 'page'; spaceId: string; nodeId: string } = {
  kind: 'page',
  spaceId: 'alpha',
  nodeId: 'n-01',
};
const SPACE_LINK = 'dsh-space://space/alpha';
const PAGE_LINK = 'dsh-space://space/alpha/page/n-01';

describe('引用 key（稳定可解析）', () => {
  it('键形状：页面用 spaceId:nodeId，空间用 spaceId:space', () => {
    expect(spaceRefKey(PAGE)).toBe('alpha:n-01');
    expect(spaceRefKey(SPACE)).toBe('alpha:space');
  });

  it('解析回原对象', () => {
    expect(parseSpaceRefKey(spaceRefKey(PAGE))).toEqual(PAGE);
    expect(parseSpaceRefKey(spaceRefKey(SPACE))).toEqual(SPACE);
  });

  it('拒绝非法键', () => {
    for (const bad of ['', 'alpha', ':n-01', 'alpha:', '-bad:n-01', 'alpha:n 01', 'alpha:n1:extra']) {
      expect(parseSpaceRefKey(bad), bad).toBeNull();
    }
  });

  it('尾段 space 按空间引用解释（页面 id 恰好叫 space 的极端情形以链接为准）', () => {
    expect(parseSpaceRefKey('alpha:space')).toEqual(SPACE);
    expect(parseSpaceRefKey('alpha:spacey')).toEqual({
      kind: 'page',
      spaceId: 'alpha',
      nodeId: 'spacey',
    });
  });

  it('链接始终是规范形式（含 in-app 路由写法归一）', () => {
    expect(spaceRefLink(PAGE)).toBe(PAGE_LINK);
    expect(spaceRefLink(SPACE)).toBe(SPACE_LINK);
    expect(spaceRefLink({ kind: 'page', spaceId: 'beta', nodeId: 'n-9' })).toBe(
      'dsh-space://space/beta/page/n-9',
    );
  });
});

describe('spaceRefInsert', () => {
  it('构造 chip 插入描述：source 与 UserText 规则一致，clipboardText 是链接', () => {
    expect(SPACE_REF_SOURCE).toBe(SPACE_REF_ID);
    const insert = spaceRefInsert(PAGE);
    expect(insert.source).toBe(SPACE_REF_ID);
    expect(insert.ref).toBe('alpha:n-01');
    expect(insert.label).toBe('n-01');
    expect(insert.clipboardText).toBe(PAGE_LINK);
    // appearance 显式 undefined：空间/页面没有 DSH 内置字形。
    expect('appearance' in insert).toBe(true);
    expect(insert.appearance).toBeUndefined();
  });

  it('label 可被可读名称覆盖，空白仍回落 id 尾段', () => {
    expect(spaceRefInsert(PAGE, '  设计稿  ').label).toBe('设计稿');
    expect(spaceRefInsert(PAGE, '   ').label).toBe('n-01');
    expect(spaceRefInsert(SPACE).label).toBe('alpha');
    expect(spaceRefDefaultLabel(SPACE)).toBe('alpha');
  });

  it('ref 可解析回原引用（chip → 链接往返）', () => {
    for (const ref of [SPACE, PAGE]) {
      const parsed = parseSpaceRefKey(spaceRefInsert(ref).ref);
      expect(parsed).toEqual(ref);
      expect(spaceRefLink(parsed!)).toBe(spaceRefInsert(ref).clipboardText);
    }
  });

  it('降级文本保留类型与名称', () => {
    expect(spaceRefPlaceholderText(PAGE)).toBe('[页面] n-01');
    expect(spaceRefPlaceholderText(SPACE)).toBe('[空间] alpha');
    expect(spaceRefPlaceholderText(PAGE, '设计稿')).toBe('[页面] 设计稿');
  });
});

describe('mergeRefs（去重与上限）', () => {
  it('既有在前、新增按入参顺序，同一引用不重复', () => {
    const merged = mergeRefs([SPACE], [PAGE, SPACE]);
    expect(merged.refs).toEqual([SPACE, PAGE]);
    expect(merged.added).toEqual([PAGE]);
    expect(spaceRefIdentity(SPACE)).not.toBe(spaceRefIdentity(PAGE));
  });

  it('上限 20：既有 19 条时只再加一条', () => {
    const existing = Array.from({ length: SPACE_REF_LIMIT - 1 }, (_, index) => ({
      kind: 'page' as const,
      spaceId: 'alpha',
      nodeId: `n-${index}`,
    }));
    const merged = mergeRefs(existing, [PAGE, { ...SPACE }]);
    expect(merged.refs).toHaveLength(SPACE_REF_LIMIT);
    expect(merged.added).toEqual([PAGE]);
    expect(mergeRefs(existing, [SPACE], SPACE_REF_LIMIT).added).toHaveLength(1);
  });

  it('已满时不再追加', () => {
    const full = Array.from({ length: SPACE_REF_LIMIT }, (_, index) => ({
      kind: 'space' as const,
      spaceId: `s-${index}`,
      nodeId: null,
    }));
    const merged = mergeRefs(full, [PAGE]);
    expect(merged.refs).toHaveLength(SPACE_REF_LIMIT);
    expect(merged.added).toEqual([]);
  });

  it('既有集合里的重复项也被折叠', () => {
    const merged = mergeRefs([SPACE, SPACE], []);
    expect(merged.refs).toEqual([SPACE]);
  });
});

describe('草稿扫描', () => {
  it('两种链接写法都识别，按出现顺序、同一引用只留第一处', () => {
    const draft = `看 ${PAGE_LINK} 和 #/space/beta/doc/n-2 再 ${PAGE_LINK}`;
    const found = refsInDraft(draft);
    expect(found.map((match) => match.ref)).toEqual([
      PAGE,
      { kind: 'page', spaceId: 'beta', nodeId: 'n-2' },
    ]);
    expect(found[0]?.raw).toBe(PAGE_LINK);
    expect(found[0]?.start).toBe(2);
    expect(found[0]?.end).toBe(2 + PAGE_LINK.length);
  });

  it('已变成 chip 的链接不再算裸露', () => {
    const draft = `前 ${PAGE_LINK} 后 ${SPACE_LINK}`;
    const pageStart = draft.indexOf(PAGE_LINK);
    const occurrences = [{ offset: pageStart, length: PAGE_LINK.length }];
    const uncovered = uncoveredRefInDraft(draft, occurrences);
    expect(uncovered?.ref).toEqual(SPACE);
    expect(uncoveredRefInDraft(PAGE_LINK, [{ offset: 0, length: PAGE_LINK.length }])).toBeNull();
  });

  it('没有链接时返回空', () => {
    expect(refsInDraft('只是普通文字')).toEqual([]);
    expect(uncoveredRefInDraft('只是普通文字', [])).toBeNull();
  });
});

describe('toDetectSpan（剪贴板坐标 → detect 坐标）', () => {
  it('没有 chip 时坐标不变', () => {
    expect(toDetectSpan([], 3, 8, 7)).toEqual({ start: 3, end: 8, draftRev: 7 });
  });

  it('chip 之后的区间按 length-1 前移', () => {
    const chip = { offset: 0, length: 30 };
    expect(toDetectSpan([chip], 31, 40, 2)).toEqual({ start: 2, end: 11, draftRev: 2 });
  });

  it('chip 之前的区间不受影响', () => {
    const chip = { offset: 40, length: 30 };
    expect(toDetectSpan([chip], 2, 10, 2)).toEqual({ start: 2, end: 10, draftRev: 2 });
  });

  it('碰到/切开 chip 时拒绝（无法 CAS 替换）', () => {
    const chip = { offset: 10, length: 30 };
    expect(toDetectSpan([chip], 5, 20, 2)).toBeNull();
    expect(toDetectSpan([chip], 10, 12, 2)).toBeNull();
  });

  it('非法区间拒绝', () => {
    expect(toDetectSpan([], -1, 4, 0)).toBeNull();
    expect(toDetectSpan([], 4, 4, 0)).toBeNull();
    expect(toDetectSpan([], 1.5, 4, 0)).toBeNull();
  });
});

describe('pasteRefsToDraft（多链接 / 上限 / 去重 / caret）', () => {
  it('单个链接 → 转换目标 + 降级文本 + 登记', () => {
    const draft = `看 ${PAGE_LINK} 这段`;
    const caret = draft.length;
    const result = pasteRefsToDraft(draft, caret, [PAGE]);
    expect(result.converted?.ref).toEqual(PAGE);
    expect(result.converted?.start).toBe(2);
    expect(result.converted?.end).toBe(2 + PAGE_LINK.length);
    expect(result.readable).toBe('[页面] n-01');
    expect(result.draft).toBe('看 [页面] n-01 这段');
    expect(result.registered).toEqual(PAGE);
    expect(result.remaining).toEqual([]);
    // caret 在链接之后：按替换的长度差回移。
    expect(result.caret).toBe(draft.length + ('[页面] n-01'.length - PAGE_LINK.length));
  });

  it('粘贴多链接只转第一个，其余进 remaining', () => {
    const beta = { kind: 'page' as const, spaceId: 'beta', nodeId: 'n-2' };
    const draft = `${PAGE_LINK} 与 ${SPACE_LINK} 与 #/space/beta/doc/n-2`;
    const result = pasteRefsToDraft(draft, 0, [PAGE, SPACE, beta]);
    expect(result.converted?.ref).toEqual(PAGE);
    expect(result.registered).toEqual(PAGE);
    expect(result.remaining).toEqual([SPACE, beta]);
    expect(result.draft).toContain(SPACE_LINK);
    expect(result.draft).toContain('#/space/beta/doc/n-2');
  });

  it('允许集合之外（未传入）的链接不转换', () => {
    const result = pasteRefsToDraft(`看 ${PAGE_LINK}`, 0, [SPACE]);
    expect(result.converted).toBeNull();
    expect(result.draft).toBe(`看 ${PAGE_LINK}`);
  });

  it('空允许集合表示什么都不转', () => {
    const result = pasteRefsToDraft(PAGE_LINK, 0, []);
    expect(result.converted).toBeNull();
    expect(result.registered).toBeNull();
    expect(result.remaining).toEqual([]);
    expect(result.draft).toBe(PAGE_LINK);
  });

  it('去重：已登记的目标照常转换但不重复登记', () => {
    const result = pasteRefsToDraft(PAGE_LINK, 0, [PAGE], { existing: [PAGE] });
    expect(result.converted?.ref).toEqual(PAGE);
    expect(result.registered).toBeNull();
    expect(result.draft).toBe('[页面] n-01');
  });

  it('上限 20：已满时不再转换，链接原样保留', () => {
    const full = Array.from({ length: SPACE_REF_LIMIT }, (_, index) => ({
      kind: 'space' as const,
      spaceId: `s-${index}`,
      nodeId: null,
    }));
    const result = pasteRefsToDraft(PAGE_LINK, 0, [PAGE], { existing: full });
    expect(result.converted).toBeNull();
    expect(result.registered).toBeNull();
    expect(result.remaining).toEqual([PAGE]);
    expect(result.draft).toBe(PAGE_LINK);
    expect(SPACE_REF_LIMIT_TEXT).toContain(String(SPACE_REF_LIMIT));
    expect(SPACE_REF_EMPTY_TEXT).toBe('当前未引用空间或页面');
  });

  it('上限前一条仍可转换', () => {
    const almost = Array.from({ length: SPACE_REF_LIMIT - 1 }, (_, index) => ({
      kind: 'space' as const,
      spaceId: `s-${index}`,
      nodeId: null,
    }));
    const result = pasteRefsToDraft(PAGE_LINK, 0, [PAGE], { existing: almost });
    expect(result.converted?.ref).toEqual(PAGE);
    expect(result.registered).toEqual(PAGE);
  });

  it('caret 边界：起点不动、区间内落到替换文本末尾、越界夹住', () => {
    const draft = `前缀${PAGE_LINK}后缀`;
    const start = draft.indexOf(PAGE_LINK);
    const end = start + PAGE_LINK.length;
    // caret 恰在链接起点：留在起点之前。
    expect(pasteRefsToDraft(draft, start, [PAGE]).caret).toBe(start);
    // caret 落在链接内部：落到替换文本末尾。
    expect(pasteRefsToDraft(draft, start + 3, [PAGE]).caret).toBe(start + '[页面] n-01'.length);
    // caret 在链接之后：按长度差平移。
    expect(pasteRefsToDraft(draft, end, [PAGE]).caret).toBe(start + '[页面] n-01'.length);
    // 越界 caret 先夹到草稿长度再换算。
    expect(pasteRefsToDraft(draft, 9999, [PAGE]).caret).toBe(draft.length - PAGE_LINK.length + '[页面] n-01'.length);
    // 负数与 NaN 夹到 0。
    expect(pasteRefsToDraft(draft, -5, [PAGE]).caret).toBe(0);
    expect(pasteRefsToDraft(draft, Number.NaN, [PAGE]).caret).toBe(0);
  });

  it('可读名称与自定义降级文本', () => {
    const result = pasteRefsToDraft(PAGE_LINK, 0, [PAGE], {
      label: () => '设计稿',
      placeholder: (ref, label) => `${label}<${ref.spaceId}>`,
    });
    expect(result.readable).toBe('设计稿<alpha>');
    expect(result.draft).toBe('设计稿<alpha>');
  });
});

// --- 注册面：DSH 结构接口 ------------------------------------------------

interface FakeChatRef {
  id: string;
  kind: 'space' | 'page';
  spaceId: string;
  nodeId: string | null;
  label: string;
  addedAt: string;
  addedBy: 'me' | 'alter';
  state: 'current';
}

interface FakeChat {
  id: string;
  kind: 'page' | 'side';
  sessionId: string | null;
  title: string;
  sideOf: { sessionId: string; title: string } | null;
  refs: FakeChatRef[];
  quote: string | null;
  createdAt: string;
  updatedAt: string;
}

function fakeChat(sessionId: string, refs: FakeChatRef[] = []): FakeChat {
  return {
    id: `chat-${sessionId}`,
    kind: 'page',
    sessionId,
    title: '页面对话',
    sideOf: null,
    refs,
    quote: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createStore(initial: FakeChat[]) {
  let chats = initial;
  const listeners = new Set<() => void>();
  const setRefs = vi.fn(async (sessionId: string, refs: { kind: 'space' | 'page'; spaceId?: string; nodeId?: string | null }[]) => {
    chats = chats.map((chat) => (chat.sessionId === sessionId
      ? {
        ...chat,
        refs: refs.map((input, index) => ({
          id: `${sessionId}-ref-${index}`,
          kind: input.kind,
          spaceId: input.spaceId ?? '',
          nodeId: input.nodeId ?? null,
          label: input.nodeId ?? input.spaceId ?? '',
          addedAt: '2026-01-01T00:00:00.000Z',
          addedBy: 'me' as const,
          state: 'current' as const,
        })),
      }
      : chat));
    for (const listener of [...listeners]) listener();
  });
  const store = {
    chats: {
      getSnapshot: () => chats,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    chatOfSession: (sessionId: string) => chats.find((chat) => chat.sessionId === sessionId),
    actions: { setRefs },
  };
  return { store, setRefs, chats: () => chats };
}

/** 记录会话作用域 dispatch 的假上下文。 */
function createContext(options: { session?: boolean; triggers?: boolean } = {}) {
  const session = options.session ?? true;
  const withTriggers = options.triggers ?? true;
  const bailCalls: { subject: unknown; name: string; payload: unknown }[] = [];
  let bailResult: unknown = true;
  const scoped = {
    bail(subject: unknown, name: string, payload: unknown) {
      bailCalls.push({ subject, name, payload });
      return bailResult;
    },
  };
  const scope = vi.fn(() => (session ? scoped : undefined));
  const dockRegistrations: { options: Record<string, unknown>; component: unknown }[] = [];
  const dockDisposers: (() => void)[] = [];
  const injectedKeys: string[] = [];
  const sources: unknown[] = [];
  const sourceDisposers: (() => void)[] = [];
  const slots = {
    inject(key: string, callback: () => () => void) {
      injectedKeys.push(key);
      dockDisposers.push(callback());
    },
    register(options: Record<string, unknown>, component: unknown) {
      dockRegistrations.push({ options, component });
      const dispose = vi.fn();
      return dispose;
    },
  };
  const inputTriggers = {
    registerSource(source: unknown) {
      sources.push(source);
      const dispose = vi.fn();
      sourceDisposers.push(dispose);
      return dispose;
    },
  };
  const ctx = {
    slots,
    sessions: { scope },
    get: (name: string) => (name === 'inputTriggers' && withTriggers ? inputTriggers : undefined),
  };
  return {
    ctx,
    scoped,
    bailCalls,
    setBailResult(value: unknown) {
      bailResult = value;
    },
    dockRegistrations,
    dockDisposers,
    injectedKeys,
    sources,
    sourceDisposers,
    scope,
  };
}

describe('registerSpaceRefComposer（注册与 codec）', () => {
  it('占住 conversation.input.dock，并注册只提供 codec 的 space-ref 触发源', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      expect(harness.injectedKeys).toEqual([SPACE_REF_DOCK_SLOT]);
      expect(harness.dockRegistrations).toHaveLength(1);
      expect(harness.dockRegistrations[0]?.options).toEqual({
        name: SPACE_REF_DOCK_SLOT,
        id: SPACE_REF_DOCK_ID,
        order: SPACE_REF_DOCK_ORDER,
      });
      expect(typeof harness.dockRegistrations[0]?.component).toBe('function');

      expect(harness.sources).toHaveLength(1);
      const source = harness.sources[0] as {
        trigger: string;
        name: string;
        showGroupTitle?: boolean;
        candidates: (session: unknown, request: { query: string; signal: AbortSignal }) => Promise<unknown[]>;
        codec: { clipboardText(ref: string): string; serialize(ref: string, signal: AbortSignal): Promise<string> };
      };
      expect(source.trigger).toBe('@');
      expect(source.name).toBe(SPACE_REF_SOURCE);
      // 不产生候选行、不渲染分组标题：注册 source 只是为了拿 codec。
      expect(source.showGroupTitle).toBe(false);
      return source.candidates({ sessionId: 's1' }, {
        query: '',
        signal: new AbortController().signal,
      }).then(async (candidates) => {
        expect(candidates).toEqual([]);
        expect(source.codec.clipboardText('alpha:n-01')).toBe(PAGE_LINK);
        expect(source.codec.clipboardText('alpha:space')).toBe(SPACE_LINK);
        await expect(source.codec.serialize('alpha:n-01', new AbortController().signal)).resolves.toBe(PAGE_LINK);
        // 不可解析的 key 原样返回，不抛。
        expect(source.codec.clipboardText('raw')).toBe('raw');
      });
    } finally {
      dispose();
    }
  });

  it('chip 点击打开原文：页面引用交给右栏，空间引用与无桥时不动作', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    const openPageInRightbar = vi.fn();
    const bridge = { openPageInRightbar } as unknown as Parameters<typeof setSpaceBridge>[0];
    const previous = setSpaceBridge(bridge);
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      const source = harness.sources[0] as {
        openReference?: (
          session: { sessionId: string },
          reference: { ref: string; appearance?: string },
        ) => boolean;
      };
      const session = { sessionId: 's1' };
      expect(source.openReference?.(session, { ref: 'alpha:n-01' })).toBe(true);
      expect(openPageInRightbar).toHaveBeenCalledWith({ spaceId: 'alpha', nodeId: 'n-01' });
      // 空间引用打开的是空间入口（`nodeId: null`），不是某个页面。
      expect(source.openReference?.(session, { ref: 'alpha:space' })).toBe(true);
      expect(openPageInRightbar).toHaveBeenCalledWith({ spaceId: 'alpha', nodeId: null });
      // 无法解析的键原样放弃，不猜目标。
      expect(source.openReference?.(session, { ref: 'raw' })).toBe(false);
      expect(openPageInRightbar).toHaveBeenCalledTimes(2);
      // 没有装配桥（例如测试或部分启动）时同样只返回 false。
      setSpaceBridge(null);
      expect(source.openReference?.(session, { ref: 'alpha:n-01' })).toBe(false);
    } finally {
      setSpaceBridge(previous);
      dispose();
    }
  });

  it('cleanup 拆掉引用条与 codec', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    const disposeDock = harness.dockDisposers[0];
    const disposeSource = harness.sourceDisposers[0];
    dispose();
    expect(disposeDock).toHaveBeenCalledTimes(1);
    expect(disposeSource).toHaveBeenCalledTimes(1);
    // 拆除后 chip 通路关闭：没有任何 codec 的 chip 插进草稿会毒化发送。
    expect(insertSpaceRefChip('s1', spaceRefInsert(PAGE), { start: 0, end: 1, draftRev: 1 })).toBe(false);
    expect(harness.bailCalls).toEqual([]);
  });
});

describe('insertSpaceRefChip（会话作用域事件通路）', () => {
  it('以 scope 上下文为 dispatch subject 发 slash/input-insert-reference', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      const span = { start: 4, end: 9, draftRev: 3 };
      expect(insertSpaceRefChip('s1', spaceRefInsert(PAGE), span)).toBe(true);
      expect(harness.bailCalls).toHaveLength(1);
      const call = harness.bailCalls[0];
      // subject 必须是 scope 上下文本身：事件按会话过滤（同一 scope 上的监听才收）。
      expect(call?.subject).toBe(harness.scoped);
      expect(call?.name).toBe(SPACE_REF_INSERT_EVENT);
      expect(call?.payload).toEqual({ reference: spaceRefInsert(PAGE), span });
    } finally {
      dispose();
    }
  });

  it('shell 拒绝（bail 无返回值）时不认为插入成功', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      harness.setBailResult(undefined);
      expect(insertSpaceRefChip('s1', spaceRefInsert(PAGE), { start: 0, end: 1, draftRev: 1 })).toBe(false);
    } finally {
      dispose();
    }
  });

  it('会话没有 retain 的 scope 时不插（没有 shell 可写）', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext({ session: false });
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      expect(insertSpaceRefChip('s1', spaceRefInsert(PAGE), { start: 0, end: 1, draftRev: 1 })).toBe(false);
      expect(harness.bailCalls).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('拿不到触发源（没有 codec）时绝不插 chip', () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext({ triggers: false });
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      expect(insertSpaceRefChip('s1', spaceRefInsert(PAGE), { start: 0, end: 1, draftRev: 1 })).toBe(false);
      expect(harness.bailCalls).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe('autoReferenceSession（新建对话自动带入引用）', () => {
  it('把引用写进 chat 记录', async () => {
    const chat = fakeChat('s1');
    const { store, setRefs, chats } = createStore([chat]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      await expect(autoReferenceSession('s1', {
        kind: 'page',
        spaceId: 'alpha',
        nodeId: 'n-01',
      })).resolves.toBe(true);
      expect(setRefs).toHaveBeenCalledTimes(1);
      expect(setRefs.mock.calls[0]?.[0]).toBe('s1');
      expect(setRefs.mock.calls[0]?.[1]).toEqual([
        { kind: 'page', spaceId: 'alpha', nodeId: 'n-01' },
      ]);
      expect(chats()[0]?.refs).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('已登记的引用不重复写；空间引用 nodeId 归 null', async () => {
    const existing: FakeChatRef[] = [{
      id: 'ref-0',
      kind: 'space',
      spaceId: 'alpha',
      nodeId: null,
      label: 'alpha',
      addedAt: '2026-01-01T00:00:00.000Z',
      addedBy: 'me',
      state: 'current',
    }];
    const { store, setRefs } = createStore([fakeChat('s1', existing)]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      await expect(autoReferenceSession('s1', {
        kind: 'space',
        spaceId: 'alpha',
        nodeId: 'ignored',
      })).resolves.toBe(false);
      expect(setRefs).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('没有 chat 记录（或未装配）时返回 false', async () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    const dispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    try {
      await expect(autoReferenceSession('other', {
        kind: 'page',
        spaceId: 'alpha',
        nodeId: 'n-01',
      })).resolves.toBe(false);
    } finally {
      dispose();
    }
    // 拆掉装配后模块级单例清空。
    await expect(autoReferenceSession('s1', {
      kind: 'page',
      spaceId: 'alpha',
      nodeId: 'n-01',
    })).resolves.toBe(false);
  });
});

// --- 引用条渲染（jsdom） ----------------------------------------------------

/** 一条 chat ref 记录（Host 读回的形状）。 */
function fastRef(
  id: string,
  kind: 'space' | 'page',
  spaceId: string,
  nodeId: string | null,
  label: string,
  state: 'current' | 'archived' | 'missing' = 'current',
): FakeChatRef {
  return {
    id,
    kind,
    spaceId,
    nodeId,
    label,
    addedAt: '2026-01-01T00:00:00.000Z',
    addedBy: 'me',
    state,
  };
}

/** 输入框状态替身（InputZone.input 的结构子集）。 */
function inputState(draft = '', occurrences: { offset: number; length: number }[] = []) {
  return {
    draft,
    draftRev: 1,
    occurrences: occurrences.map((occ, index) => ({
      source: SPACE_REF_SOURCE,
      ref: `ref-${index}`,
      offset: occ.offset,
      length: occ.length,
      clipboardText: '',
    })),
    phase: 'plain' as const,
  };
}

let activeDispose: (() => void) | null = null;

/** 装配引用条并渲染它；返回 store 侧观察点。 */
function renderDock(
  initial: FakeChat[],
  input = inputState(),
  options: {
    session?: boolean;
    triggers?: boolean;
    resolveTarget?: (ref: { kind: 'space' | 'page'; spaceId: string; nodeId: string | null }) => Promise<boolean>;
    pickTargets?: () => Promise<{
      spaces: { id: string; name: string }[];
      pages: { id: string; spaceId: string; title: string }[];
    } | undefined>;
  } = {},
) {
  const { store, setRefs } = createStore(initial);
  const harness = createContext(options);
  activeDispose = registerSpaceRefComposer({
    ctx: harness.ctx,
    store,
    ...(options.resolveTarget === undefined ? {} : { resolveTarget: options.resolveTarget }),
    ...(options.pickTargets === undefined ? {} : { pickTargets: options.pickTargets }),
  });
  const inputActions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: input.draftRev }),
    insertText: vi.fn(() => true),
  };
  const view = render(createElement(SpaceRefDock, {
    session: { sessionId: 's1' },
    input,
    inputActions,
  }));
  return { ...view, setRefs, harness, inputActions, input };
}

afterEach(() => {
  cleanup();
  activeDispose?.();
  activeDispose = null;
});

describe('SpaceRefDock（引用条渲染）', () => {
  it('没有 Space 会话记录时不渲染（普通会话不加噪音）', () => {
    const { container } = renderDock([fakeChat('other')]);
    expect(container.firstChild).toBeNull();
  });

  it('空态显示「当前未引用空间或页面」，标题带上限', () => {
    const { container } = renderDock([fakeChat('s1')]);
    expect(screen.getByText('引用')).toBeTruthy();
    expect(screen.getByText(SPACE_REF_EMPTY_TEXT)).toBeTruthy();
    expect(container.querySelector('[data-space-refs]')).not.toBeNull();
    expect(container.querySelector('div[title]')?.getAttribute('title')).toBe(SPACE_REF_DOCK_LABEL);
  });

  it('每枚引用渲染成「图标 名称 类型 ×」', () => {
    const { container } = renderDock([
      fakeChat('s1', [
        fastRef('ref-0', 'page', 'alpha', 'n-01', 'n-01'),
        fastRef('ref-1', 'space', 'beta', null, 'beta'),
      ]),
    ]);
    expect(screen.getByText('n-01')).toBeTruthy();
    expect(screen.getByText('页面')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.getByText('空间')).toBeTruthy();
    expect(container.querySelector('svg.lucide-file-text')).not.toBeNull();
    expect(container.querySelector('svg.lucide-orbit')).not.toBeNull();
    expect(container.querySelectorAll('svg.lucide-x')).toHaveLength(2);
    expect(screen.queryByText(SPACE_REF_EMPTY_TEXT)).toBeNull();
  });

  it('× 用剩余引用重写 chat 记录（内联，不用 toast）', async () => {
    const { setRefs } = renderDock([
      fakeChat('s1', [
        fastRef('ref-0', 'page', 'alpha', 'n-01', 'n-01'),
        fastRef('ref-1', 'space', 'beta', null, 'beta'),
      ]),
    ]);
    fireEvent.click(screen.getByRole('button', { name: '移除引用：n-01' }));
    await waitFor(() => {
      expect(setRefs).toHaveBeenCalledTimes(1);
    });
    expect(setRefs.mock.calls[0]?.[0]).toBe('s1');
    expect(setRefs.mock.calls[0]?.[1]).toEqual([
      { kind: 'space', spaceId: 'beta', nodeId: null },
    ]);
  });

  it('删除引用后内联提示「已移除引用」，继续输入即消失', async () => {
    const { rerender, input, inputActions } = renderDock([
      fakeChat('s1', [fastRef('ref-0', 'page', 'alpha', 'n-01', 'n-01')]),
    ]);
    fireEvent.click(screen.getByRole('button', { name: '移除引用：n-01' }));
    await waitFor(() => {
      expect(screen.getByText(SPACE_REF_REMOVED_TEXT)).toBeTruthy();
    });
    rerender(createElement(SpaceRefDock, {
      session: { sessionId: 's1' },
      input: { ...input, draft: '继续输入', draftRev: input.draftRev + 1 },
      inputActions,
    }));
    await waitFor(() => {
      expect(screen.queryByText(SPACE_REF_REMOVED_TEXT)).toBeNull();
    });
  });

  it('空态提供「选择空间」入口，选中页面后插 chip 并登记', async () => {
    const pickTargets = vi.fn(async () => ({
      spaces: [{ id: 'alpha', name: '空间一' }],
      pages: [{ id: 'n-01', spaceId: 'alpha', title: '调研页面' }],
    }));
    const { harness, setRefs } = renderDock([fakeChat('s1')], inputState(), { pickTargets });
    fireEvent.click(screen.getByText(SPACE_REF_PICK_TEXT));
    await waitFor(() => expect(screen.getByText('调研页面')).toBeTruthy());
    expect(pickTargets).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('调研页面'));
    await waitFor(() => expect(harness.bailCalls).toHaveLength(1));
    expect(harness.bailCalls[0]?.payload).toEqual(
      expect.objectContaining({
        reference: spaceRefInsert({ kind: 'page', spaceId: 'alpha', nodeId: 'n-01' }),
      }),
    );
    await waitFor(() => {
      expect(setRefs).toHaveBeenCalledWith('s1', [
        { kind: 'page', spaceId: 'alpha', nodeId: 'n-01' },
      ]);
    });
    // 面板选完即收起。
    expect(screen.queryByText('调研页面')).toBeNull();
  });

  it('「＋」入口开面板、过滤已引用目标、没有目标时说明', async () => {
    const { setRefs } = renderDock(
      [fakeChat('s1', [fastRef('ref-0', 'space', 'alpha', null, '空间一')])],
      inputState(),
      {
        pickTargets: async () => ({
          spaces: [{ id: 'alpha', name: '空间一' }],
          pages: [],
        }),
      },
    );
    fireEvent.click(screen.getByRole('button', { name: SPACE_REF_ADD_LABEL }));
    await waitFor(() => expect(screen.getByText('没有可引用的空间或页面')).toBeTruthy());
    // 已引用的空间不出现在候选里。
    expect(screen.queryByText('空间一')).toBeTruthy(); // chip 自己仍在条上
    expect(screen.queryByRole('button', { name: '空间一' })).toBeNull();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('选择面板读取失败时行内说明，可再次点开重试', async () => {
    const pickTargets = vi.fn(async () => Promise.reject(new Error('rpc down')));
    renderDock([fakeChat('s1')], inputState(), { pickTargets });
    fireEvent.click(screen.getByText(SPACE_REF_PICK_TEXT));
    await waitFor(() => {
      expect(screen.getByText(`${SPACE_REF_PICK_FAILED}（rpc down）`)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(SPACE_REF_PICK_TEXT));
    await waitFor(() => expect(pickTargets).toHaveBeenCalledTimes(2));
  });

  it('没有 pickTargets 时不渲染选择入口', () => {
    renderDock([fakeChat('s1')], inputState());
    expect(screen.queryByText(SPACE_REF_PICK_TEXT)).toBeNull();
    expect(screen.queryByRole('button', { name: SPACE_REF_ADD_LABEL })).toBeNull();
  });

  it('达到上限时不渲染「＋」', () => {
    const refs = Array.from({ length: SPACE_REF_LIMIT }, (_, index) => (
      fastRef(`ref-${index}`, 'space', 'alpha', null, `s-${index}`)
    ));
    renderDock([fakeChat('s1', refs)], inputState(), {
      pickTargets: async () => ({ spaces: [], pages: [] }),
    });
    expect(screen.queryByRole('button', { name: SPACE_REF_ADD_LABEL })).toBeNull();
  });

  it('失效引用置灰并带删除线提示，仍可移除', () => {
    const { container } = renderDock([
      fakeChat('s1', [
        fastRef('ref-0', 'page', 'alpha', 'n-01', '已删页面', 'missing'),
        fastRef('ref-1', 'page', 'alpha', 'n-02', '已归档页面', 'archived'),
        fastRef('ref-2', 'space', 'beta', null, '正常空间'),
      ]),
    ]);
    const chips = container.querySelectorAll('[data-state]');
    expect(chips).toHaveLength(3);
    expect(chips[0]?.getAttribute('data-state')).toBe('missing');
    expect(chips[0]?.getAttribute('title')).toContain('该页面已被删除或无访问权限');
    expect(chips[1]?.getAttribute('data-state')).toBe('archived');
    expect(chips[1]?.getAttribute('title')).toContain('该页面已归档');
    expect(chips[2]?.getAttribute('data-state')).toBe('current');
    // 失效 chip 仍是可移除的引用：× 按钮在。
    expect(screen.getByRole('button', { name: '移除引用：已删页面' })).toBeTruthy();
  });

  it('达到上限时显示内联上限提示', () => {
    const refs = Array.from({ length: SPACE_REF_LIMIT }, (_, index) => (
      fastRef(`ref-${index}`, 'space', 'alpha', null, `s-${index}`)
    ));
    const { container } = renderDock([fakeChat('s1', refs)]);
    expect(screen.getByText(SPACE_REF_LIMIT_TEXT)).toBeTruthy();
    expect(container.querySelectorAll('svg.lucide-orbit')).toHaveLength(SPACE_REF_LIMIT);
  });
});

describe('SpaceRefDock（草稿里的链接就地转 chip）', () => {
  it('绑定了会话的草稿：插 chip 并登记引用', async () => {
    const draft = `看 ${PAGE_LINK}`;
    const start = draft.indexOf(PAGE_LINK);
    const { harness, setRefs, inputActions } = renderDock(
      [fakeChat('s1')],
      inputState(draft),
    );
    const expected = spaceRefInsert(PAGE);
    await waitFor(() => {
      expect(harness.bailCalls).toHaveLength(1);
    });
    expect(harness.bailCalls[0]?.subject).toBe(harness.scoped);
    expect(harness.bailCalls[0]?.name).toBe(SPACE_REF_INSERT_EVENT);
    expect(harness.bailCalls[0]?.payload).toEqual({
      reference: expected,
      span: { start, end: start + PAGE_LINK.length, draftRev: 1 },
    });
    expect(inputActions.insertText).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(setRefs).toHaveBeenCalledWith('s1', [
        { kind: 'page', spaceId: 'alpha', nodeId: 'n-01' },
      ]);
    });
  });

  it('没有 chat 记录的会话也转 chip，但不登记（没有登记处）', async () => {
    const draft = `看 ${PAGE_LINK}`;
    const { harness, setRefs } = renderDock([fakeChat('other')], inputState(draft));
    await waitFor(() => {
      expect(harness.bailCalls).toHaveLength(1);
    });
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('chip 通路不可用时降级为可读文本并登记引用', async () => {
    const draft = `看 ${PAGE_LINK}`;
    const start = draft.indexOf(PAGE_LINK);
    const { harness, setRefs, inputActions } = renderDock(
      [fakeChat('s1')],
      inputState(draft),
      { triggers: false },
    );
    await waitFor(() => {
      expect(inputActions.insertText).toHaveBeenCalledTimes(1);
    });
    // 没有 codec 就绝不插 chip：直接走文本降级。
    expect(harness.bailCalls).toEqual([]);
    expect(inputActions.insertText).toHaveBeenCalledWith('[页面] n-01', {
      start,
      end: start + PAGE_LINK.length,
      draftRev: 1,
    });
    await waitFor(() => {
      expect(setRefs).toHaveBeenCalledTimes(1);
    });
  });

  it('目标已删除/无权限时保留原文并内联提示，不转换也不登记', async () => {
    const draft = `看 ${PAGE_LINK}`;
    const { harness, setRefs, inputActions } = renderDock(
      [fakeChat('s1')],
      inputState(draft),
      { resolveTarget: async () => false },
    );
    await waitFor(() => {
      expect(screen.getByText(SPACE_REF_UNRECOGNIZED_TEXT)).toBeTruthy();
    });
    expect(harness.bailCalls).toEqual([]);
    expect(inputActions.insertText).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('目标校验通过后才转换（校验拿不到结果时照常转换）', async () => {
    const draft = `看 ${PAGE_LINK}`;
    const seen: unknown[] = [];
    const { harness } = renderDock(
      [fakeChat('s1')],
      inputState(draft),
      {
        resolveTarget: async (ref) => {
          seen.push(ref);
          return true;
        },
      },
    );
    await waitFor(() => {
      expect(harness.bailCalls).toHaveLength(1);
    });
    expect(seen).toEqual([{ kind: 'page', spaceId: 'alpha', nodeId: 'n-01' }]);
  });

  it('校验查询失败时按不确定处理，照常转换', async () => {
    const draft = `看 ${PAGE_LINK}`;
    const { harness } = renderDock(
      [fakeChat('s1')],
      inputState(draft),
      { resolveTarget: async () => Promise.reject(new Error('rpc down')) },
    );
    await waitFor(() => {
      expect(harness.bailCalls).toHaveLength(1);
    });
  });

  it('已达到上限时保留链接文本，不插 chip 也不登记', async () => {
    const full = Array.from({ length: SPACE_REF_LIMIT }, (_, index) => (
      fastRef(`ref-${index}`, 'space', 'alpha', null, `s-${index}`)
    ));
    const { harness, setRefs } = renderDock([fakeChat('s1', full)], inputState(`看 ${PAGE_LINK}`));
    expect(harness.bailCalls).toEqual([]);
    expect(setRefs).not.toHaveBeenCalled();
    expect(screen.getByText(SPACE_REF_LIMIT_TEXT)).toBeTruthy();
  });
});

describe('autoReferenceSession + 引用条（新建对话带入引用）', () => {
  it('排队的引用在空草稿里插入 chip', async () => {
    const { store, setRefs } = createStore([fakeChat('s1')]);
    const harness = createContext();
    activeDispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    await autoReferenceSession('s1', { kind: 'page', spaceId: 'alpha', nodeId: 'n-01' });
    expect(setRefs).toHaveBeenCalledTimes(1);
    render(createElement(SpaceRefDock, {
      session: { sessionId: 's1' },
      input: inputState(''),
      inputActions: {
        captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
        insertText: vi.fn(() => true),
      },
    }));
    await waitFor(() => {
      expect(harness.bailCalls).toHaveLength(1);
    });
    expect(harness.bailCalls[0]?.payload).toEqual({
      reference: spaceRefInsert(PAGE),
      span: { start: 0, end: 0, draftRev: 1 },
    });
    // 引用条本身也显示这条引用。
    expect(screen.getByText('n-01')).toBeTruthy();
  });

  it('草稿非空时不插 chip（不抢用户已经在写的内容）', async () => {
    const { store } = createStore([fakeChat('s1')]);
    const harness = createContext();
    activeDispose = registerSpaceRefComposer({ ctx: harness.ctx, store });
    await autoReferenceSession('s1', { kind: 'page', spaceId: 'alpha', nodeId: 'n-01' });
    render(createElement(SpaceRefDock, {
      session: { sessionId: 's1' },
      input: inputState('已经在写的内容'),
      inputActions: {
        captureInsertion: () => ({ start: 6, end: 6, draftRev: 1 }),
        insertText: vi.fn(() => true),
      },
    }));
    expect(harness.bailCalls).toEqual([]);
  });
});
