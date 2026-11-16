import type { Chat } from '@alter/protocol';

/**
 * vendor 侧的桥转发层。
 *
 * Space UI 不允许反向 import `src/`（vendor 编译别名只有 `@alter/*` 与相对
 * 路径），因此把 `src/integration/bridge.ts` 的 `SpaceBridge` 契约在这里结构化
 * 重复一份；`src/entry.js` 在插件装配时把真实桥安装进来（`setUiBridge`），
 * UI 通过 `uiBridge()` 读取。桥未安装（测试环境、桥能力缺失）时返回 `null`，
 * 所有新入口据此优雅降级。
 */
export interface SpaceBridgeLike {
  /**
   * 展开/收起 DSH 右侧栏。
   *
   * DSH 右栏按会话工作：空间面板占主区时没有会话面，桥会先把对话bring到主区
   * 再展开，并把目标页面放到右栏（返回 `engaged`）。返回 `unavailable` 时调用
   * 方应行内说明原因。
   */
  toggleRightbar(target?: {
    spaceId?: string;
    nodeId?: string | null;
  }): Promise<'toggled' | 'engaged' | 'unavailable'> | void;
  /** 从页面发起 AI 对话：创建普通 DSH 会话并登记页面对话与引用。 */
  startPageChat(input: {
    spaceId: string;
    /** `null` 表示只引用空间（无页面）。 */
    nodeId: string | null;
    nodeTitle: string;
    /** 在哪里打开：主视图、DSH 右栏，或只登记（空间面板自带右列内嵌）。 */
    open?: 'main' | 'aside' | 'record';
  }): Promise<Chat>;
  /** 引用该空间/页面的全部对话（`updatedAt` 倒序，refs 已解析）。 */
  relatedChats(ref: { spaceId: string; nodeId: string | null }): Promise<Chat[]>;
  /**
   * 在右侧栏打开一个空间页面（`nodeId` 为 `null` 时打开该空间入口）；
   * 需要会话面时由桥先建立。
   */
  openPageInRightbar(input: { spaceId: string; nodeId: string | null }): Promise<void> | void;
  /** 打开一条对话记录（页面对话进主会话，侧边对话进右栏）。 */
  openChat(chat: Chat): void;
  /** 删除一条对话记录（不动 DSH 会话本身）。 */
  deleteChat(chatId: string): Promise<void>;
  /**
   * 会话是否已从 DSH 会话列表消失（「相关会话」行据此标注「已删除」并禁点）。
   * 缺省时不标注：宁可打开失败，也不把可用会话误标成已删除。
   */
  sessionGone?(sessionId: string): boolean;
}

let current: SpaceBridgeLike | null = null;

/**
 * 安装桥（`src/entry.js` 装配时调用，把 `spaceBridge()` 的单例接进来）；
 * 传 `null` 拆桥（插件卸载、测试收尾）。
 */
export function setUiBridge(bridge: SpaceBridgeLike | null): void {
  current = bridge;
}

/** 当前安装的桥；未安装时为 `null`，调用方据此禁用或隐藏新入口。 */
export function uiBridge(): SpaceBridgeLike | null {
  return current;
}
