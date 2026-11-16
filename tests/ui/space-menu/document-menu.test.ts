// @vitest-environment jsdom
/**
 * 文档页新增的三个菜单能力与右侧栏开关（全部经 vendor 侧桥转发）。
 *
 * 桥未安装（测试默认）时新入口以禁用态呈现；安装后：开关与「在右侧栏打开」
 * 调桥转发、「AI 对话」创建页面对话（失败走页内 toast）、「相关会话」在挂载与
 * 切换页面时预取数量并按数量显隐（N=0 不出现）。嵌入式页面（右栏内打开）不
 * 渲染开关与「在右侧栏打开」。
 */
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, SpaceNode } from '../../../vendor/protocol/src/index';
import { setUiBridge } from '../../../vendor/ui-space/src/bridge';
import type { SpaceBridgeLike } from '../../../vendor/ui-space/src/bridge';
import { SpaceContext } from '../../../vendor/ui-space/src/runtime';
import { DocumentView } from '../../../vendor/ui-space/src/views/DocumentView';
import {
  createPageClient,
  createPageContext,
  docOf,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
  type PageClient,
  type PageContext,
} from '../../support/document-page';

const now = new Date().toISOString();

function sampleDoc() {
  return docOf([paragraph('blk_p', '编辑器正文')], 7);
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    kind: 'page',
    sessionId: 'sess-1',
    title: '鉴权方案讨论',
    sideOf: null,
    refs: [
      {
        id: 'ref-1',
        kind: 'page',
        spaceId: 'sp-1',
        nodeId: 'doc-1',
        label: '测试文档',
        addedAt: now,
        addedBy: 'me',
        state: 'current',
      },
    ],
    quote: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type BridgeMock = SpaceBridgeLike & Record<string, ReturnType<typeof vi.fn>>;

function makeBridge(overrides: Partial<SpaceBridgeLike> = {}): BridgeMock {
  return {
    toggleRightbar: vi.fn(),
    startPageChat: vi.fn(async () => makeChat()),
    relatedChats: vi.fn(async () => [] as Chat[]),
    openPageInRightbar: vi.fn(),
    openChat: vi.fn(),
    deleteChat: vi.fn(async () => undefined),
    ...overrides,
  } as BridgeMock;
}

let restoreResizeObserver: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setUiBridge(null);
  restoreResizeObserver();
});

/** 打开文档菜单并等第一项就绪。 */
async function openDocMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '文档菜单' }));
  await screen.findByRole('menuitem', { name: '复制链接' });
}

/**
 * 等预取请求落定并把结果提交到页面。
 *
 * 菜单项显隐依赖预取结果，所以断言菜单之前先让 Promise 的 then 与 React
 * 更新都跑完（`act` 冲一轮微任务）。
 */
async function settleRelatedChats(bridge: BridgeMock): Promise<void> {
  await waitFor(() => expect(bridge.relatedChats).toHaveBeenCalled());
  await act(async () => {});
}

/** 以 embedded 模式挂载文档页（右栏内打开的形态）。 */
function mountEmbeddedPage(node: SpaceNode, client: PageClient): PageContext {
  const context = createPageContext(node, client);
  render(
    createElement(
      SpaceContext.Provider,
      { value: context.value as never },
      createElement(DocumentView, { node, embedded: true } as never),
    ),
  );
  return context;
}

describe('文档页右侧栏开关', () => {
  it('未安装桥时按钮以禁用态呈现', () => {
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    const toggle = screen.getByRole('button', {
      name: '展开/收起右侧栏',
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  it('点击开关经桥切换右侧栏', () => {
    const bridge = makeBridge();
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    const toggle = screen.getByRole('button', {
      name: '展开/收起右侧栏',
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(bridge.toggleRightbar).toHaveBeenCalledTimes(1);
  });
});

describe('文档菜单新增项', () => {
  it('新项位于「复制链接」之后、「新建子文档」之前，非嵌入式含「在右侧栏打开」', async () => {
    const bridge = makeBridge({
      relatedChats: vi.fn(async () => [makeChat()]),
    });
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await settleRelatedChats(bridge);
    await openDocMenu();
    const labels = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual([
      '复制链接',
      'AI 对话',
      '相关会话',
      '在右侧栏打开',
      '新建子文档',
      '历史记录',
      '历史评论',
      '导出 Markdown',
    ]);
  });

  it('未安装桥时「相关会话」不出现，其余新项仍在菜单内但为禁用态', async () => {
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await openDocMenu();
    for (const label of ['AI 对话', '在右侧栏打开']) {
      expect(
        screen
          .getByRole('menuitem', { name: label })
          .hasAttribute('data-disabled'),
      ).toBe(true);
    }
    expect(screen.queryByRole('menuitem', { name: '相关会话' })).toBeNull();
  });

  it('「AI 对话」经桥以当前页面发起对话', async () => {
    const bridge = makeBridge();
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await openDocMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'AI 对话' }));
    await waitFor(() =>
      expect(bridge.startPageChat).toHaveBeenCalledWith({
        spaceId: 'sp-1',
        nodeId: 'doc-1',
        nodeTitle: '测试文档',
      }),
    );
  });

  it('「AI 对话」创建失败时用页内 toast 提示与原因', async () => {
    const bridge = makeBridge({
      startPageChat: vi.fn(async () => {
        throw new Error('工作区未绑定');
      }),
    });
    setUiBridge(bridge);
    const page = mountDocumentPage(
      makeNode(sampleDoc()),
      createPageClient(sampleDoc()),
    );
    await openDocMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'AI 对话' }));
    await waitFor(() =>
      expect(page.toast).toHaveBeenCalledWith(
        '对话创建失败，请重试（工作区未绑定）',
      ),
    );
  });

  it('挂载后预取数量：桥返回 2 条时菜单出现「相关会话」，点击直接展示预取结果', async () => {
    const bridge = makeBridge({
      relatedChats: vi.fn(async () => [
        makeChat(),
        makeChat({ id: 'chat-2', title: '另一条讨论' }),
      ]),
    });
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await settleRelatedChats(bridge);
    expect(bridge.relatedChats).toHaveBeenCalledTimes(1);
    expect(bridge.relatedChats).toHaveBeenCalledWith({
      spaceId: 'sp-1',
      nodeId: 'doc-1',
    });
    await openDocMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '相关会话' }));
    const dialog = await screen.findByRole('dialog', { name: '相关会话' });
    expect(within(dialog).getByText('鉴权方案讨论')).toBeTruthy();
    expect(within(dialog).getByText('另一条讨论')).toBeTruthy();
    // 已预取到列表：打开弹层复用数据，不再发第二次请求、也不显示加载态。
    expect(within(dialog).queryByText('正在加载…')).toBeNull();
    expect(bridge.relatedChats).toHaveBeenCalledTimes(1);
  });

  it('桥返回 0 条时菜单不出现「相关会话」', async () => {
    const bridge = makeBridge();
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await settleRelatedChats(bridge);
    expect(bridge.relatedChats).toHaveBeenCalledWith({
      spaceId: 'sp-1',
      nodeId: 'doc-1',
    });
    await openDocMenu();
    expect(screen.queryByRole('menuitem', { name: '相关会话' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'AI 对话' })).toBeTruthy();
  });

  it('预取失败按 0 条处理：菜单不出现该项、不弹 toast、不留错误弹层', async () => {
    const bridge = makeBridge({
      relatedChats: vi.fn(async () => {
        throw new Error('桥请求失败');
      }),
    });
    setUiBridge(bridge);
    const page = mountDocumentPage(
      makeNode(sampleDoc()),
      createPageClient(sampleDoc()),
    );
    await settleRelatedChats(bridge);
    await openDocMenu();
    expect(screen.queryByRole('menuitem', { name: '相关会话' })).toBeNull();
    expect(page.toast).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '相关会话' })).toBeNull();
  });

  it('挂载与页面切换（node.id 变化）各预取一次，切到 0 条的页面后菜单项消失', async () => {
    const relatedChats = vi
      .fn()
      .mockResolvedValueOnce([makeChat()])
      .mockResolvedValueOnce([]);
    const bridge = makeBridge({ relatedChats });
    setUiBridge(bridge);
    const first = sampleDoc();
    const page = mountDocumentPage(makeNode(first), createPageClient(first));
    await settleRelatedChats(bridge);
    await openDocMenu();
    expect(screen.getByRole('menuitem', { name: '相关会话' })).toBeTruthy();
    const second = docOf([paragraph('blk_p', '第二个页面')], 8);
    await act(async () => {
      page.rerenderPage(makeNode(second, { id: 'doc-2', title: '第二篇' }));
    });
    await waitFor(() =>
      expect(bridge.relatedChats).toHaveBeenCalledTimes(2),
    );
    expect(bridge.relatedChats).toHaveBeenLastCalledWith({
      spaceId: 'sp-1',
      nodeId: 'doc-2',
    });
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: '相关会话' })).toBeNull(),
    );
    // 菜单仍开着（其余项还在），所以「不出现」来自数量归零而不是菜单被关。
    expect(screen.getByRole('menuitem', { name: '复制链接' })).toBeTruthy();
  });

  it('行点击经桥打开对话并关闭弹层', async () => {
    const bridge = makeBridge({
      relatedChats: vi.fn(async () => [makeChat()]),
    });
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await settleRelatedChats(bridge);
    await openDocMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '相关会话' }));
    fireEvent.click(await screen.findByText('鉴权方案讨论'));
    await waitFor(() => expect(bridge.openChat).toHaveBeenCalledTimes(1));
    expect(bridge.openChat.mock.calls[0]![0].id).toBe('chat-1');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '相关会话' })).toBeNull(),
    );
  });

  it('行尾「删除」经桥删除记录并从弹层移除该行，数量减一后菜单项仍在', async () => {
    const bridge = makeBridge({
      relatedChats: vi.fn(async () => [
        makeChat(),
        makeChat({ id: 'chat-2', title: '另一条讨论' }),
      ]),
    });
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await settleRelatedChats(bridge);
    await openDocMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '相关会话' }));
    const dialog = await screen.findByRole('dialog', { name: '相关会话' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '删除对话 鉴权方案讨论' }),
    );
    await waitFor(() =>
      expect(bridge.deleteChat).toHaveBeenCalledWith('chat-1'),
    );
    await waitFor(() =>
      expect(screen.queryByText('鉴权方案讨论')).toBeNull(),
    );
    expect(within(dialog).getByText('另一条讨论')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '相关会话' })).toBeNull(),
    );
    await openDocMenu();
    expect(screen.getByRole('menuitem', { name: '相关会话' })).toBeTruthy();
  });

  it('删除唯一一行后数量归零，菜单项随之消失', async () => {
    const bridge = makeBridge({
      relatedChats: vi.fn(async () => [makeChat()]),
    });
    setUiBridge(bridge);
    mountDocumentPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    await settleRelatedChats(bridge);
    await openDocMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '相关会话' }));
    const dialog = await screen.findByRole('dialog', { name: '相关会话' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '删除对话 鉴权方案讨论' }),
    );
    await waitFor(() =>
      expect(bridge.deleteChat).toHaveBeenCalledWith('chat-1'),
    );
    await waitFor(() =>
      expect(within(dialog).getByText('暂无相关会话')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '相关会话' })).toBeNull(),
    );
    await openDocMenu();
    expect(screen.queryByRole('menuitem', { name: '相关会话' })).toBeNull();
    // 删除只改本地列表，不重新预取。
    expect(bridge.relatedChats).toHaveBeenCalledTimes(1);
  });
});

describe('嵌入式文档页（右栏内打开）', () => {
  it('不渲染右侧栏开关，菜单没有「在右侧栏打开」', async () => {
    setUiBridge(makeBridge());
    mountEmbeddedPage(makeNode(sampleDoc()), createPageClient(sampleDoc()));
    expect(
      screen.queryByRole('button', { name: '展开/收起右侧栏' }),
    ).toBeNull();
    await openDocMenu();
    const labels = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toContain('AI 对话');
    expect(labels).not.toContain('在右侧栏打开');
  });
});
