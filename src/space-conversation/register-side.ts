/**
 * Unified registration entry for the 侧边对话 (side conversations) feature.
 *
 * `src/entry.js` calls `registerSideChats` inside its conversation-integration
 * effect; this module composes the three halves and hands back one cleanup:
 *
 * - `side.tsx` — the selection interaction and branch-creation flow;
 * - `side-tab.tsx` — the right-sidebar tab type, body and resource provider;
 * - `side-history.tsx` — the conditionally registered 侧边对话历史 view.
 *
 * The context face mirrors the DSH client services the feature consumes as
 * local structural types, so the client bundle never imports `@deepseek-ai/*`
 * at runtime (self-contained bundle rule).
 */
import type { ChatStore } from '../chat/store';
import {
  createSideChatLauncher,
  registerSideInteraction,
} from './side';
import { registerSideChatTab } from './side-tab';
import { registerSideHistoryView } from './side-history';
import {
  createSideUnreadTracker,
  type SideSessionStatusSource,
} from './side-status';

/**
 * The DSH client services the side-chat feature consumes. Every face is a
 * structural subset of what the runtime injects once the plugin declares its
 * client dependencies (`dsh.client.inject` in package.json).
 */
export interface SideDeps {
  /**
   * The client root context, as the apply-time world hands it out: slots,
   * sessions (fork/retain/binding), the right-sidebar navigation controller
   * and tab registry, the resource registry, and the conversation
   * interactions registry.
   */
  readonly ctx: {
    readonly slots: {
      inject(key: string, callback: () => () => void): () => void;
      register(options: Record<string, unknown>, component: unknown): () => void;
    };
    readonly sessions: {
      fork(opts: {
        sessionId: string;
        onCreated?: (childId: string) => void;
      }): Promise<string>;
      retain(
        sessionId: string,
        options: { source: string; signal?: AbortSignal },
      ): {
        readonly sessionId: string;
        readonly ready: Promise<unknown>;
        release(): void;
      };
      binding?(
        sessionId: string,
      ):
        | {
            session: {
              getSnapshot(): {
                removed: boolean;
                subagent: { address: { mode: string } } | null;
              };
            };
          }
        | undefined;
    };
    readonly sidebarRight: {
      openResource(address: string, options?: Record<string, unknown>): void;
    };
    readonly sidebarRightTabs: {
      register(definition: {
        readonly id: string;
        readonly kind: string;
        readonly priority: 'extension' | 'builtin' | 'fallback';
        readonly multiple?: boolean;
        readonly keepMounted?: boolean;
        readonly title: (address: string) => string;
      }): () => void;
    };
    readonly resources: {
      register(provider: {
        readonly protocol: string;
        open(
          address: string,
          ctx: { signal: AbortSignal },
        ): AsyncIterable<
          | { ok: true; value: unknown }
          | { ok: false; error: { code: string; message: string } }
        >;
      }): () => void;
    };
    readonly uiConversation: {
      readonly interactions: {
        register(definition: {
          readonly id: string;
          readonly onInteraction: (request: {
            readonly trigger: 'selection' | 'contextmenu';
            readonly hasSelection: boolean;
            readonly readText: () => string | null;
            readonly preventDefault: () => void;
            readonly sessionId: string;
            readonly open: () => void;
          }) => void;
        }): () => void;
      };
    };
    /**
     * Session UI status (`ctx.uiSession.sessionStatus`): the running bit and
     * DSH's completion-unread flag the history row markers read. Absent on a
     * partial boot, which marks branches without the 「已完成」 state.
     */
    readonly uiSession?: {
      readonly sessionStatus?: SideSessionStatusSource;
    };
  };
  /** The chat store over the Host `chat.*` endpoints (`createChatStore`). */
  readonly store: ChatStore;
  /**
   * Open a branch as the main conversation (P1「在主对话中打开」); absent on a
   * partial boot, which simply does not offer the menu item.
   */
  readonly openMain?: (sessionId: string) => void;
}

/**
 * Build the branch-creation flow over one chat store.
 *
 * Shared by the selection gesture, the assistant action and the right-sidebar
 * conversation tab's toolbar, so every way into a side conversation forks and
 * records the branch identically.
 * @param ctx - session fork/list and right-sidebar faces.
 * @param store - chat store recording the branch.
 * @returns the launcher.
 */
export function createSpaceSideChat(
  ctx: SideDeps['ctx'],
  store: ChatStore,
) {
  return createSideChatLauncher(ctx, (input) =>
    store.actions.createSideChat({
      sessionId: input.sessionId,
      sideOf: input.sideOf,
      quote: input.quote,
    }));
}

/**
 * Register the complete 侧边对话 chain on the DSH conversation: the selection
 * action that branches a main conversation, the right-sidebar tab that opens
 * the branch (bound to the forked session through the `spacechat` resource
 * protocol), and the conditionally registered history view.
 * @param deps - the client context face and the chat store.
 * @returns cleanup tearing every registration down in reverse order.
 */
export function registerSideChats(deps: SideDeps): () => void {
  const { ctx, store, openMain } = deps;
  const startSideChat = createSpaceSideChat(ctx, store);
  // One tracker serves both surfaces: the history row shows the marker and the
  // branch tab clears it (opening a tab and opening a row are both "seen").
  const unread = createSideUnreadTracker(ctx.uiSession?.sessionStatus);
  // Each seat is independent: a reload can leave one of them registered from an
  // earlier module instance, and that refusal must not cost the others — the
  // tab body in particular, because it is what the column dispatches.
  const guard = (run: () => () => void): (() => void) => {
    try {
      return run();
    } catch {
      return () => {};
    }
  };
  const disposeHistory = guard(() => registerSideHistoryView({
    ...ctx,
    unread,
    ...(openMain === undefined ? {} : { openMain }),
  }, store));
  const disposeTab = guard(() => registerSideChatTab({ ...ctx, unread }, store));
  const disposeInteraction = guard(() => registerSideInteraction(ctx, startSideChat));
  return () => {
    disposeInteraction();
    disposeTab();
    disposeHistory();
    unread.dispose();
  };
}
