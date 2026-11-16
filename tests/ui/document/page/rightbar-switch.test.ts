// @vitest-environment jsdom
/**
 * 文档页右上角的「右侧栏」开关（规范 4.1）。
 *
 * 主面板里的页面提供开关：点击经桥展开/收起右栏，桥回答 `unavailable` 时行内
 * 说明原因而不是留一个死按钮；已经嵌在右栏里的页面不再渲染这个开关（右栏
 * 本来就是展开的）。桥未装配时按钮禁用。
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPageClient,
  docOf,
  installResizeObserver,
  makeNode,
  mountDocumentPage,
  paragraph,
} from '../../../support/document-page';
import { setUiBridge } from '../../../../vendor/ui-space/src/bridge';

let restoreResizeObserver: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setUiBridge(null);
  restoreResizeObserver();
});

/** One plain paragraph page. */
function pageNode() {
  return makeNode(docOf([paragraph('blk_1', '正文')]));
}

/** Bridge double whose toggle answers the given outcome. */
function installBridge(outcome: 'toggled' | 'engaged' | 'unavailable' = 'toggled') {
  const toggleRightbar = vi.fn(async () => outcome);
  setUiBridge({
    toggleRightbar,
    startPageChat: vi.fn(async () => Promise.reject(new Error('unused'))),
    relatedChats: vi.fn(async () => []),
    openPageInRightbar: vi.fn(),
    openChat: vi.fn(),
    deleteChat: vi.fn(async () => undefined),
  } as never);
  return toggleRightbar;
}

const SWITCH = '展开/收起右侧栏';

describe('文档页右侧栏开关', () => {
  it('主面板里渲染开关，点击带上当前页面发起', async () => {
    const toggleRightbar = installBridge('toggled');
    mountDocumentPage(pageNode(), createPageClient(docOf([])));
    const button = screen.getByRole('button', { name: SWITCH });
    fireEvent.click(button);
    await waitFor(() => {
      expect(toggleRightbar).toHaveBeenCalledWith({ spaceId: 'sp-1', nodeId: 'doc-1' });
    });
  });

  it('桥回答 unavailable 时行内说明原因，不留死按钮', async () => {
    installBridge('unavailable');
    const mounted = mountDocumentPage(pageNode(), createPageClient(docOf([])));
    fireEvent.click(screen.getByRole('button', { name: SWITCH }));
    await waitFor(() => {
      expect(mounted.toast).toHaveBeenCalledWith(
        '右侧栏需要对话视图；请在左侧会话列表打开一个对话后重试',
      );
    });
  });

  it('桥未装配时禁用（不假装可用）', () => {
    setUiBridge(null);
    mountDocumentPage(pageNode(), createPageClient(docOf([])));
    const button = screen.getByRole('button', { name: SWITCH });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('嵌入在右栏里的页面不渲染这个开关', () => {
    installBridge('toggled');
    mountDocumentPage(pageNode(), createPageClient(docOf([])), {}, { embedded: true });
    expect(screen.queryByRole('button', { name: SWITCH })).toBeNull();
  });
});
