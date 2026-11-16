/**
 * Registration of the 「空间页面」 right-sidebar tab type.
 *
 * A tab type is two registrations sharing one id:
 * 1. `ctx.sidebarRightTabs.register` declares the type — the `kind` that
 *    `ctx.sidebarRight.openTab(kind, { params })` opens by, the title, the
 *    guide entry card and `keepMounted` (tab bodies survive tab switches).
 * 2. The body mounts under the keyed `sidebar.right.pane.tab` seat, keyed by the
 *    type's `id`. The seat belongs to another plugin, so the registration goes
 *    through `ctx.slots.inject(seat, …)` — a foreign keyed seat cannot be
 *    registered into directly, and a throw here would take down every
 *    registration that shares the same effect.
 *
 * The services the body consumes are installed separately through
 * `src/space-rightbar/context.ts` (`setSpacePageServices` / `setUiBridge`) —
 * install them before registering so an early tab render never sees the
 * placeholder. Opening is the framework's job: page tabs dedupe within the
 * pane and re-opening focuses the existing tab.
 */
import type { SpaceClientContext } from '../integration/dsh';
import { NewChatTab } from './NewChatTab';
import { registerTabBody, registerTabType } from './register-body';
import { SpacePageGuideIcon, SpacePageTab } from './SpacePageTab';

/** Tab-type id; the body slot key must be the same string. */
export const SPACE_PAGE_TAB_ID = '@alter-dsh/space/space-page';
/** `kind` the framework opens the tab by (`sidebarRight.openTab(kind, …)`). */
export const SPACE_PAGE_TAB_KIND = 'alter-space.page';

/** Register the 「空间页面」 tab type; returns a cleanup for both disposers. */
export function registerSpacePageTab(ctx: SpaceClientContext): () => void {
  const tabs = ctx.sidebarRightTabs;
  if (!tabs) {
    // Host without the tab-type service: keep the rest of the plugin alive.
    return () => {};
  }
  const disposeTabType = registerTabType(tabs, {
    id: SPACE_PAGE_TAB_ID,
    kind: SPACE_PAGE_TAB_KIND,
    priority: 'extension',
    title: () => '空间',
    keepMounted: true,
    guide: [
      {
        id: 'space-page',
        order: 5,
        title: () => '空间页面',
        description: () => '在右侧打开空间页面，或直接新建对话',
        icon: SpacePageGuideIcon,
      },
    ],
  }, undefined);
  const disposeBody = registerTabBody(
    ctx,
    'sidebar.right.pane.tab',
    SPACE_PAGE_TAB_ID,
    SpacePageTab as never,
  );
  return () => {
    // Body first, then the type: never leave a body behind for a removed type.
    disposeBody();
    disposeTabType();
  };
}

/** Tab-type id of the 「新建对话」 guide entry. */
export const NEW_CHAT_TAB_ID = '@alter-dsh/space/new-chat';
/** `kind` the guide entry's box opens. */
export const NEW_CHAT_TAB_KIND = 'alter-space.new-chat';

/**
 * Register the 「新建对话」 tab type: its guide box is the entry, its body
 * creates the conversation and opens it beside itself.
 * @param ctx - client context carrying the tab-type service and slots.
 * @returns a cleanup for both disposers.
 */
export function registerNewChatTab(ctx: SpaceClientContext): () => void {
  const tabs = ctx.sidebarRightTabs;
  if (!tabs) return () => {};
  const disposeTabType = registerTabType(tabs, {
    id: NEW_CHAT_TAB_ID,
    kind: NEW_CHAT_TAB_KIND,
    priority: 'extension',
    title: () => '新建对话',
    guide: [
      {
        id: 'space-new-chat',
        order: 6,
        title: () => '新建对话',
        description: () => '创建一个引用当前页面或空间的对话，并在右侧打开',
      },
    ],
  }, undefined);
  const disposeBody = registerTabBody(
    ctx,
    'sidebar.right.pane.tab',
    NEW_CHAT_TAB_ID,
    NewChatTab as never,
  );
  return () => {
    disposeBody();
    disposeTabType();
  };
}
