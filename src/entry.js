/**
 * The Space feature as a self-contained DSH Web client plugin.
 *
 * The Space UI and data-layer sources live under `vendor/`; the Host half
 * (`lib/host`) owns a SQLite-backed Space authority.
 * This file is the client assembly seam: it mounts `SpaceApp` on the Host via
 * `ctx.connection.rpc` and registers the panel/sidebar entry.
 *
 * - `vendor/ui-space` renders the whole Space module (`SpaceApp`).
 * - `vendor/ui-system` supplies the shared controls and the `--alter-*` tokens.
 * - `src/space-client.ts` implements `SpaceService` over the Host RPC channel.
 */
import { createElement, useEffect } from 'react';
import { Orbit } from 'lucide-react';
import { attachDocumentClient } from './document/client-access';
import {
  createSpaceClient,
  createSpaceDocumentClient,
  createSpaceSettingsClient,
  createSpaceMigrationClient,
} from './client/rpc';
import { createSpaceStorageClient } from './client/storage';
import { createReloadContinuity } from './app/reload-continuity';
import { createSpaceRouter } from './app/router.js';
import { SpaceShell } from './app/shell';
import { DIRECTORY_PICKER_UNAVAILABLE } from './app/native-directory-field';
import resetCss from './app/global-reset.css?inline';
import { createChatStore } from './chat/store';
import { createSpaceChatClient } from './chat/client';
import { createPageChat } from './integration/page-chat';
import { holdCenterPanel } from './integration/center-panel';
import { toggleSpaceRightbar } from './integration/rightbar';
import { setSpaceBridge } from './integration/bridge';
import {
  setUiBridge,
  setSpacePageServices,
} from './space-rightbar/context';
import {
  registerNewChatTab,
  registerSpacePageTab,
} from './space-rightbar/register';
import {
  registerSpaceSessionTab,
  setSessionTabBranch,
} from './space-conversation/session-tab';
import { registerSpaceRefCards } from './space-conversation/register-cards';
import {
  setSpaceRefPreviewResolver,
  setSpaceRefStateResolver,
} from './space-conversation/cards';
import { deleteChatRecord } from './space-conversation/delete-chat';
import {
  autoReferenceSession,
  registerSpaceRefComposer,
} from './space-conversation/refs';
import {
  createSpaceSideChat,
  registerSideChats,
} from './space-conversation/register-side';
import { buildSpaceChatAddress } from './space-conversation/address';
import { SIDE_CHAT_TAB_KIND } from './space-conversation/side';
import {
  SESSION_TAB_KIND,
  buildSessionTabAddress,
} from './space-conversation/session-tab';
import '@alter/ui-system/tokens.css';
import './app/host.css';

/** Main-panel key; the sidebar panel entry reuses the same id. */
const PANEL_ID = 'alter-space';
/** Locale namespace for plugin-owned UI copy. */
const NS = 'alter-space';
const dictionaries = {
  zh: { panel: '空间' },
  en: { panel: 'Space' },
};

function SpacePanel({
  service,
  storage,
  settings,
  migration,
  router,
  pickDirectory,
}) {
  useEffect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@alter-dsh/space';
    tag.dataset.pluginReset = 'box-sizing';
    tag.textContent = resetCss;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, []);

  return createElement(
    'div',
    { className: 'alter-space-host' },
    createElement(SpaceShell, {
      service,
      storage,
      settings,
      migration,
      router,
      pickDirectory,
    }),
  );
}

/**
 * Resolve the host directory picker on demand.
 *
 * DSH's client workspace domain owns the same picker its own "add workspace"
 * flow uses: native folder dialog on desktop, DSH browse dialog in the web
 * profile. The service is read lazily (apply may run before it is active) and
 * a dedicated error code lets the field fall back to the built-in browser.
 * @param ctx - the client plugin context.
 */
function createHostDirectoryPicker(ctx, settings) {
  return async () => {
    // Server mode lists the server's filesystem; the host's native picker
    // would return a local path with no meaning there.
    const snapshot = await settings.get().catch(() => null);
    if (snapshot?.mode === 'server') {
      const error = new Error('服务端模式使用远端目录浏览或手工输入');
      error.code = DIRECTORY_PICKER_UNAVAILABLE;
      throw error;
    }
    const ui =
      typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
    if (ui === undefined || typeof ui.pickDirectory !== 'function') {
      const error = new Error('当前宿主不支持系统目录选择');
      error.code = DIRECTORY_PICKER_UNAVAILABLE;
      throw error;
    }
    const picked = await ui.pickDirectory();
    return typeof picked === 'string' && picked.trim() !== ''
      ? picked.trim()
      : null;
  };
}

function SpaceIcon({ size = 18 }) {
  return createElement(Orbit, {
    size,
    strokeWidth: 1.6,
    'aria-hidden': 'true',
  });
}

/**
 * Open one DSH session as a right-sidebar conversation tab.
 *
 * Page conversations must stay readable beside the page, so they get their own
 * resource tab instead of navigating the main column away (which would also
 * drop the page's rightbar session). Failures stay silent here: the caller's
 * inline notice already reported the conversation could not be created.
 * @param clientCtx - the client context carrying the sidebar controller.
 * @param sessionId - the session to embed.
 */
async function openSessionAside(clientCtx, sessionId, page) {
  // Resolving the column's Session may go through the workspace flow, which is
  // allowed to navigate; the reader stays on the Space panel either way.
  const center = holdCenterPanel(clientCtx);
  try {
    // A resource tab lives in a Session-backed column, so make sure the column
    // has a Session behind it — without closing one the reader already opened
    // (`expandOnly`).
    const outcome = await toggleSpaceRightbar(clientCtx, {
      ...page,
      sessionId,
      expandOnly: true,
    }).catch(() => 'unavailable');
    if (outcome === 'unavailable') return;
    clientCtx.sidebarRight.openResource(buildSessionTabAddress(sessionId), {
      kind: SESSION_TAB_KIND,
    });
  } catch {
    // The caller's inline notice already reported the failure; a missing
    // sidebar surface must not escalate into a page error.
  } finally {
    center.restore();
  }
}

export const inject = [
  'slots',
  'locale',
  'connection',
  'layout',
  'sessions',
  // `uiSession` publishes per-Session UI status (`sessionStatus`), which the
  // side-chat unread tracker reads. Cordis throws on an undeclared service, so
  // declaring it here is what keeps that chain alive.
  'uiSession',
  'uiWorkspace',
  'sidebarRight',
  'uiConversation',
];

/**
 * Register the Space panel and its sidebar entry.
 * @param ctx - the client root context.
 */
export function apply(ctx) {
  const rpc = ctx.connection.rpc;
  const service = attachDocumentClient(
    createSpaceClient(rpc),
    createSpaceDocumentClient(rpc),
  );
  const storage = createSpaceStorageClient(rpc);
  const settings = createSpaceSettingsClient(rpc);
  const migration = createSpaceMigrationClient(rpc);
  const router = createSpaceRouter();
  // DSH replaces this module in place when client.js is rebuilt; the page
  // record keeps the reader's panel and route across that replacement.
  const continuity = createReloadContinuity(ctx.layout, ctx.slots, PANEL_ID);
  const pickDirectory = createHostDirectoryPicker(ctx, settings);

  function SpaceView() {
    return createElement(SpacePanel, {
      service,
      storage,
      settings,
      migration,
      router,
      pickDirectory,

    });
  }

  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'alter-space: dictionaries',
  );
  ctx.effect(
    () => () => continuity.dispose(),
    'alter-space: reload continuity',
  );
  const t = ctx.locale.bind(NS);

  /**
   * Run one optional Conversation-side registration in isolation.
   *
   * These registrations reach into other plugins' seats and registries. A throw
   * in any one of them must not take the rest down (a foreign keyed seat, a
   * changed contract, a kind collision): the failure is reported once with its
   * label and the plugin keeps the features it could install. The dashboard for
   * what did install is the right Sidebar itself.
   * @param label - short name shown in the console message.
   * @param run - registration body returning its disposer.
   * @returns the disposer, or a no-op when the registration failed.
   */
  function safeRegister(label, run) {
    try {
      const dispose = run();
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (error) {
      console.error(`[alter-space] ${label} registration failed:`, error);
      return () => {};
    }
  }

  // --- Conversations around spaces and pages -----------------------------
  // The chat store, the bridge the Space UI reads, and the Conversation-side
  // registrations (reference cards, side chats, the Space page tab) all ride
  // one effect so plugin unload tears them down together. Services that are
  // plugins themselves (resources, the right-sidebar tab registry) resolve
  // through ctx.inject, the same way ui-subagent consumes them.
  const chatClient = createSpaceChatClient(rpc);
  const chatStore = createChatStore(chatClient);
  // Optional dependency injection is itself optional: a host double (or a
  // partial boot that does not offer Cordis injection yet) simply keeps the
  // Space panel and skips the Conversation integrations.
  if (typeof ctx.inject === 'function') ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
    scope.effect(() => {
      const clientCtx = /** @type {any} */ (scope);
      setSpacePageServices({ service });
      const bridge = {
        // DSH's own right column, which this build's profile override keeps
        // available beside plugin main panels (see overrides/rightbar). The
        // switch only expands it: the guide lists 空间页面 / 新建对话 and the
        // reader picks one. Opening a tab here would show something unbidden.
        toggleRightbar: () => toggleSpaceRightbar(clientCtx, {}),
        startPageChat: (input) =>
          createPageChat(clientCtx, chatStore, {
            spaceId: input.spaceId,
            nodeId: input.nodeId ?? null,
            title: input.nodeTitle,
          }).then(({ chat, sessionId }) => {
            // The chat record already carries the reference; this only asks the
            // composer to show it as a chip in the empty draft.
            void autoReferenceSession(sessionId, {
              kind: input.nodeId === null || input.nodeId === undefined ? 'space' : 'page',
              spaceId: input.spaceId,
              nodeId: input.nodeId ?? null,
            }).catch(() => undefined);
            if (input.open === 'record') {
              // Recorded only: the caller draws the conversation itself.
            } else if (input.open === 'aside') {
              void openSessionAside(clientCtx, sessionId, {
                spaceId: input.spaceId,
                ...(input.nodeId === null || input.nodeId === undefined
                  ? {}
                  : { nodeId: input.nodeId }),
              });
            } else clientCtx.uiWorkspace.openSession(sessionId);
            return chat;
          }),
        openSessionAside: (sessionId) => openSessionAside(clientCtx, sessionId),
        relatedChats: (ref) => chatClient.listChatsForRef(ref),
        openPageInRightbar: (input) =>
          toggleSpaceRightbar(clientCtx, {
            spaceId: input.spaceId,
            nodeId: input.nodeId ?? null,
            openPage: true,
            // Clicking a card or menu action shows the target; it must not close
            // a column the reader already opened.
            expandOnly: true,
          }).then(() => undefined),
        openChat: (chat) => {
          if (chat.sessionId === null) return;
          if (chat.kind === 'side') {
            // Resource address: the tab record keeps the branch session, so a
            // restored sidebar layout reopens the same conversation.
            clientCtx.sidebarRight.openResource(
              buildSpaceChatAddress(chat.sessionId),
              { kind: SIDE_CHAT_TAB_KIND },
            );
            return;
          }
          clientCtx.uiWorkspace.openSession(chat.sessionId);
        },
        // 「相关会话」行：会话离开 DSH 列表就标注「已删除」并不再打开。
        sessionGone: (sessionId) => {
          const list = clientCtx.sessions?.list?.getSnapshot?.();
          if (list === undefined || list === null) return false;
          return list.byId?.[sessionId] === undefined;
        },
        deleteChat: (chatId) => deleteChatRecord({
          store: chatStore,
          // 删除侧边讨论时把对应分支会话归档（规范 §4.3）：会话仍可从 DSH
          // 归档找回，但不再出现在活跃列表。
          archiveSession: (sessionId) => clientCtx.uiWorkspace.archiveSession?.(sessionId),
        }, chatId),
      };
      setSpaceBridge(bridge);
      setUiBridge(bridge);
      // Each registration is isolated: see safeRegister. The order matters only
      // for teardown (reverse), not for whether the others install.
      const disposeSpaceTab = safeRegister(
        'rightbar space page tab',
        () => registerSpacePageTab(clientCtx),
      );
      const disposeNewChat = safeRegister(
        'rightbar new chat tab',
        () => registerNewChatTab(clientCtx),
      );
      const disposeSessionTab = safeRegister(
        'session tab',
        () => registerSpaceSessionTab(clientCtx),
      );
      // Sent-message cards read the Host-derived reference state (deleted →
      // missing, archived) off the chat records, so a card whose page is gone
      // greys out instead of pretending to open it.
      setSpaceRefStateResolver((ref) => {
        for (const chat of chatStore.chats.getSnapshot()) {
          const hit = chat.refs.find((item) => item.spaceId === ref.spaceId
            && (ref.kind === 'page' ? item.nodeId === ref.nodeId : item.nodeId === null));
          if (hit !== undefined) return hit.state;
        }
        return undefined;
      });
      // 「＋」选择面板（P1 多引用）：空间列表 + 默认空间最近打开的页面。
      const pickTargets = async () => {
        try {
          const spaces = await service.listSpaces();
          const target = spaces.find((space) => space.isDefault) ?? spaces[0];
          let pages = [];
          if (target !== undefined) {
            try {
              const overview = await service.getOverview(target.id);
              pages = (overview?.recentDocs ?? []).map((node) => ({
                id: node.id,
                spaceId: node.spaceId,
                title: node.title,
              }));
            } catch {
              // 最近页面只是候选，读不到不影响空间引用。
              pages = [];
            }
          }
          return { spaces: spaces.map((space) => ({ id: space.id, name: space.name })), pages };
        } catch {
          return undefined;
        }
      };
      // Hover preview (P1): the card has no record of its own, so read the
      // target's name / owning space / last activity from the Host.
      setSpaceRefPreviewResolver(async (ref) => {
        try {
          if (ref.kind === 'space') {
            const space = await service.getSpace(ref.spaceId);
            return space === undefined ? undefined : { title: space.name };
          }
          const node = ref.nodeId === null ? undefined : await service.getNode(ref.nodeId);
          if (node === undefined) return undefined;
          const owner = await service.getSpace(node.spaceId).catch(() => undefined);
          return {
            title: node.title === '' ? '无标题' : node.title,
            ...(owner === undefined ? {} : { spaceName: owner.name }),
            updatedAt: node.activityAt,
          };
        } catch {
          return undefined;
        }
      });
      // Sent-message cards only: the composer half below owns the dock id and
      // the `space-ref` trigger source, and DSH rejects duplicates.
      const disposeRefCards = safeRegister(
        'reference cards',
        () => registerSpaceRefCards(clientCtx),
      );
      const disposeRefComposer = safeRegister(
        'reference composer',
        () => registerSpaceRefComposer({
          ctx: clientCtx,
          store: chatStore,
          pickTargets,
          // 粘贴转换前校验目标仍存在且可见：指向已删除页面的链接保留原文并
          // 行内说明，而不是换成一枚打不开的 chip。
          resolveTarget: (ref) => ref.kind === 'space'
            ? service.getSpace(ref.spaceId).then((space) => space !== undefined)
            : service.getNode(ref.nodeId).then((node) => node !== undefined
              && node !== null
              && node.deletedAt === null
              && node.spaceId === ref.spaceId),
        }),
      );
      const disposeSideChats = safeRegister('side chats', () => {
        const dispose = registerSideChats({
          ctx: clientCtx,
          store: chatStore,
          // 历史行「在主对话中打开」（P1）：把分支放到主视图，右栏标签仍可并存。
          openMain: (sessionId) => clientCtx.uiWorkspace.openSession(sessionId),
        });
        // The conversation tab's toolbar branches the conversation it shows.
        setSessionTabBranch(createSpaceSideChat(clientCtx, chatStore));
        return () => {
          setSessionTabBranch(null);
          dispose();
        };
      });
      return () => {
        disposeSideChats();
        disposeRefComposer();
        disposeRefCards();
        setSpaceRefStateResolver(null);
        setSpaceRefPreviewResolver(null);
        disposeSessionTab();
        disposeNewChat();
        disposeSpaceTab();
        setSpaceBridge(null);
        setUiBridge(null);
        setSpacePageServices(null);
      };
    }, 'alter-space: conversation integrations');
  });

  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      { name: 'main', key: PANEL_ID },
      SpaceView,
    );
    // Selecting the panel needs its entry registered. A replacement that
    // interrupted the reader is restored here, before the layout settles on
    // the Conversation for the rest of the session.
    continuity.restore();
    return dispose;
  });

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('panel'),
      },
      SpaceIcon,
    ),
  );
}
