/**
 * Side conversations (侧边对话): the conversation entries that branch a main
 * conversation, and the label helpers every side-chat surface shares.
 *
 * Two entries admit a side chat on the DSH conversation:
 *
 * - the selection gesture (`uiConversation.interactions` id
 *   `alter-space-sidechat`), whose keyed surface on
 *   `conversation.chat.text-interaction` renders 「引用文本」 beside
 *   「在侧边对话中引用」. DSH asks registered plugins in registration order and
 *   the first `open()` owns the surface, so the wider panel keeps the
 *   platform's quote behaviour available whenever this plugin wins a gesture
 *   that `message-quotes` did not claim;
 * - one action per finalized assistant reply
 *   (`conversation.chat.assistant-actions`), which branches the whole reply as
 *   the quoted text — the stable entry, present whatever owns the selection
 *   gesture.
 *
 * Both run the same branch-creation flow: fork the session (`sessions.fork`, no
 * `atSeq` — the Host inherits the latest completed-turn prefix), record the
 * chat with the quoted text and open the branch as a right-sidebar tab.
 *
 * The DSH conversation faces are mirrored as local structural types so the
 * client bundle never imports `@deepseek-ai/*` at runtime (self-contained
 * bundle rule). Failure copy is inline next to the action, never a toast; a
 * failure keeps the surface (and the selection) so the reader can retry.
 */
import { useEffect, useState } from 'react';
import { MessageCirclePlus } from 'lucide-react';
import type { Chat } from '@alter/protocol';
import { buildSpaceChatAddress } from './address';
import styles from './side.module.css';

/** Slot carrying the keyed text-interaction surfaces of one Chat view. */
export const SIDE_TEXT_INTERACTION_SLOT = 'conversation.chat.text-interaction';

/** This plugin's interaction id; also the keyed surface's registration key. */
export const SIDE_CHAT_INTERACTION_ID = 'alter-space-sidechat';

/** Slot carrying the ordered actions of one finalized assistant message. */
export const SIDE_ASSISTANT_ACTIONS_SLOT = 'conversation.chat.assistant-actions';

/** This plugin's entry id in the assistant action row. */
export const SIDE_ASSISTANT_ACTION_ID = 'alter-space-sidechat';

/** Entry order in the assistant action row; after the shipped feedback pair. */
export const SIDE_ASSISTANT_ACTION_ORDER = 20;

/** Kind of the right-sidebar tab type a created branch opens as. */
export const SIDE_CHAT_TAB_KIND = 'alter-space.side';

/** Availability rule shared with DSH's own quote action: removed sessions and
 * non-continuable subagents never offer side chats. */
export function sideChatAvailable(snapshot: {
  removed: boolean;
  subagent: { address: { mode: string } } | null;
}): boolean {
  return !snapshot.removed
    && (snapshot.subagent === null || snapshot.subagent.address.mode === 'continuable');
}

/**
 * Session snapshot fields the side-chat surfaces read. A structural mirror of
 * the session standard hook's value; every field used here exists on it.
 */
export interface SideSessionSnapshot {
  readonly sessionId: string;
  readonly removed: boolean;
  readonly running: boolean;
  readonly blank: boolean;
  readonly promptAttempted: boolean;
  readonly awaitingFirstTurn: boolean;
  readonly openState: 'cold' | 'loading' | 'open' | 'error';
  readonly subagent: { address: { mode: string } } | null;
}

/** Selector hook over the current Session snapshot, as the slot framework binds it. */
export type SideSessionSelector = <T>(
  selector: (snapshot: SideSessionSnapshot) => T,
) => T;

/** Composer verbs the selection surface uses, as the standard slot kit binds them. */
export interface SideChatInputActions {
  /** Insert one nonblank quote; false when the editor refused it. */
  insertQuote(text: string): boolean;
}

/** A session-scoped slot component bound to this plugin's conversation scope. */
export interface SideChatSessionFace {
  /** The session the surface acts on (the main conversation). */
  readonly sessionId: string;
  readonly useSession: SideSessionSelector;
}

/** Gesture request DSH hands to a registered interaction. */
export interface SideInteractionRequest {
  readonly trigger: 'selection' | 'contextmenu';
  readonly hasSelection: boolean;
  readonly readText: () => string | null;
  readonly preventDefault: () => void;
  readonly sessionId: string;
  /** Select this plugin's keyed surface for the current gesture. */
  readonly open: () => void;
}

// --- Selection surface decision ---------------------------------------------

/**
 * Text the current selection offers: the raw selection, or null when there is
 * no selection or it is blank (the composer's quote verb refuses blank input,
 * so a blank gesture is treated as nothing to act on).
 */
export function sideSelectionQuote(readText: () => string | null): string | null {
  const text = readText();
  if (text === null) return null;
  return text.trim() === '' ? null : text;
}

/** Decision table of the two-button selection surface. */
export interface SideSurfaceDecision {
  /** Whether the surface renders at all (a writable conversation). */
  readonly visible: boolean;
  /** Whether 「引用文本」 is enabled (a nonblank selection). */
  readonly quoteEnabled: boolean;
  /** Whether 「在侧边对话中引用」 is enabled (a nonblank selection). */
  readonly sideChatEnabled: boolean;
}

/**
 * Decide the selection surface from the session's writability and the current
 * selection. Both actions need the same selection, so they share one verdict;
 * an unwritable conversation renders nothing (mirroring the shipped quote
 * action, which dismisses itself).
 */
export function sideSurfaceActions(input: {
  readonly writable: boolean;
  readonly readText: () => string | null;
}): SideSurfaceDecision {
  const text = input.writable ? sideSelectionQuote(input.readText) : null;
  return {
    visible: input.writable,
    quoteEnabled: text !== null,
    sideChatEnabled: text !== null,
  };
}

// --- Assistant action text --------------------------------------------------

/** Structural slice of one assistant content block the quote reads. */
export interface SideAssistantBlock {
  readonly kind?: string;
  readonly text?: string;
}

/** Structural slice of one Chat Node payload (assistant row or turn tail). */
export interface SideAssistantNode {
  readonly data?: {
    readonly blocks?: readonly SideAssistantBlock[];
    readonly closing?: {
      readonly blocks?: readonly SideAssistantBlock[];
      readonly finalNode?: { readonly messageId?: string } | null;
    } | null;
    readonly finalNode?: { readonly messageId?: string } | null;
  } | null;
}

/** Structural slice of the Chat target snapshot the action reads. */
export interface SideChatSnapshot {
  readonly nodes: { values(): readonly SideAssistantNode[] };
}

/** Selector hook over the current Chat target, as session-scope slots bind it. */
export type SideChatSelector = <T>(selector: (snapshot: SideChatSnapshot) => T) => T;

/** Concatenated prose of one message's blocks; null when nothing is quotable. */
function assistantProse(blocks: readonly SideAssistantBlock[] | undefined): string | null {
  if (blocks === undefined) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text === '') continue;
    parts.push(text);
  }
  const text = parts.join('\n\n');
  return text === '' ? null : text;
}

/**
 * Plain text of the finalized assistant reply a row belongs to.
 *
 * The action row's owner currency is the durable message id alone, and the row
 * is a sibling of the reply body in the transcript, so the text comes from the
 * Chat target snapshot: first the closing reply a Turn's tail owns (exactly the
 * reply whose actions are rendered), then any assistant row carrying the same
 * durable message. Prose blocks are joined with a blank line so a multi-
 * paragraph reply stays a multi-paragraph quote; a reply with no prose (tool
 * rows, reasoning only) has nothing to quote and yields null.
 * @param nodes - materialized Chat nodes of the current target.
 * @param messageId - durable id of the reply whose actions are rendered.
 * @returns the quotable reply text, or null when the reply carries none.
 */
export function resolveAssistantQuote(
  nodes: readonly SideAssistantNode[],
  messageId: string,
): string | null {
  for (const node of nodes) {
    const closing = node.data?.closing;
    if (closing === undefined || closing === null) continue;
    if (closing.finalNode?.messageId !== messageId) continue;
    const text = assistantProse(closing.blocks);
    if (text !== null) return text;
  }
  for (const node of nodes) {
    if (node.data?.finalNode?.messageId !== messageId) continue;
    const text = assistantProse(node.data.blocks);
    if (text !== null) return text;
  }
  return null;
}

// --- Registration faces -----------------------------------------------------

/** Client faces `registerSideInteraction` needs (structural). */
export interface SideInteractionContext {
  readonly slots: {
    inject(key: string, callback: () => () => void): void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  readonly sessions: {
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
  readonly uiConversation: {
    readonly interactions: {
      register(
        definition: {
          readonly id: string;
          readonly onInteraction: (request: SideInteractionRequest) => void;
        },
      ): () => void;
    };
  };
}

// --- Branch creation --------------------------------------------------------

/**
 * Create one branch of a main conversation: fork, record, open the tab.
 * Resolves to the child session id; rejects when any step fails (the surface
 * shows its inline failure copy and keeps the selection).
 */
export type SideChatLauncher = (sessionId: string, quote: string) => Promise<string>;

/**
 * One row of the Host session list, as `ctx.sessions.list` publishes it.
 * `displayTitle` is the durable title, else the project basename, else the raw
 * id; `running` is the Host running state (a display fallback for uncatalogued
 * rows).
 */
export interface SideSessionListSummary {
  readonly displayTitle?: string;
  readonly running?: boolean;
}

/** Session list snapshot slice the side-chat surfaces read. */
export interface SideSessionListSnapshot {
  readonly byId: Readonly<Record<string, SideSessionListSummary | undefined>>;
}

/** Observable session list the side-chat surfaces read (structural). */
export interface SideSessionListSource {
  getSnapshot(): SideSessionListSnapshot;
  /** Present on the client's observable snapshot; absent on a bare double. */
  subscribe?(listener: () => void): () => void;
}

/**
 * Title of the main conversation a branch was forked from: the session list's
 * display title, or undefined while the session carries none (an untitled
 * session falls back to the raw id, which is not a title worth showing).
 * @param source - session list to read; absent on a boot without the service.
 * @param sessionId - the main conversation's session.
 * @returns the display title, or undefined when it is missing or generic.
 */
export function sideChatSourceTitle(
  source: SideSessionListSource | undefined,
  sessionId: string,
): string | undefined {
  const title = source?.getSnapshot().byId[sessionId]?.displayTitle;
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  if (trimmed === '' || trimmed === sessionId) return undefined;
  return trimmed;
}

/**
 * The client's session service as the side-chat surfaces read it. `fork` is the
 * member every wired boot already carries (it anchors the structural match);
 * `list` is the Host session list that supplies the branch source title and the
 * history rows' run state, absent on a boot without the service.
 */
export interface SideSessionServiceFace {
  fork(opts: {
    sessionId: string;
    onCreated?: (childId: string) => void;
  }): Promise<string>;
  readonly list?: SideSessionListSource;
}

/** Faces `createSideChatLauncher` needs (structural). */
export interface SideChatLaunchContext {
  readonly sessions: SideSessionServiceFace;
  readonly sidebarRight: {
    openResource(address: string, options?: Record<string, unknown>): void;
  };
}

/** Overrides of the branch-creation flow, for tests and for a boot without a
 * session list. */
export interface SideChatLauncherOptions {
  /** Main-conversation title lookup; omitted reads `ctx.sessions.list`. */
  readonly readTitle?: (sessionId: string) => string | undefined;
}

/**
 * Build the branch-creation flow over the DSH session service and chat store.
 * `sideOf.title` carries the main conversation's display title so the branch
 * banner and the history row say what the branch forked from; an untitled
 * session records an empty title and every surface falls back to the generic
 * 「分支自主对话」.
 * @param ctx - session fork/list and right-sidebar faces.
 * @param createSideChat - record the branch on the Host.
 * @param options - title lookup override.
 * @returns launcher creating one branch and opening it as a tab.
 */
export function createSideChatLauncher(
  ctx: SideChatLaunchContext,
  createSideChat: (input: {
    sessionId: string;
    sideOf: { sessionId: string; title: string };
    quote?: string | null;
  }) => Promise<Chat>,
  options: SideChatLauncherOptions = {},
): SideChatLauncher {
  const readTitle = options.readTitle
    ?? ((sessionId: string) => sideChatSourceTitle(ctx.sessions.list, sessionId));
  return async (sessionId, quote) => {
    const title = readTitle(sessionId) ?? '';
    const childId = await ctx.sessions.fork({ sessionId });
    await createSideChat({
      sessionId: childId,
      sideOf: { sessionId, title },
      quote,
    });
    // Resource address, not a page kind: the tab record carries the session in
    // its content id, so a restored layout reopens the same branch.
    ctx.sidebarRight.openResource(buildSpaceChatAddress(childId), {
      kind: SIDE_CHAT_TAB_KIND,
    });
    return childId;
  };
}

// --- Surfaces ---------------------------------------------------------------

/**
 * Props of the selection surface, as the keyed slot dispatch composes them:
 * the keyed owner currency (`dismiss`/`readText`/`clearSelection`), the
 * standard session kit (`useSession`/`inputActions`/`sessionId`), and the
 * entry-injected branch flow.
 */
export interface SideChatSelectionActionProps extends SideChatSessionFace {
  readonly dismiss: () => void;
  readonly readText: () => string | null;
  readonly clearSelection: () => void;
  readonly inputActions: SideChatInputActions;
  /** Entry-injected branch creation flow (fork + record + open tab). */
  readonly startSideChat: SideChatLauncher;
}

/**
 * Render the two selection actions for an admitted selection: 「引用文本」
 * (the shipped behaviour, kept so winning the gesture never removes it) and
 * 「在侧边对话中引用」. Unavailable sessions render nothing and dismiss the
 * surface; a failed branch creation keeps the surface (and the selection) open.
 * @param props - selection surface props.
 * @returns the action row, or null for an unwritable conversation.
 */
export function SideChatSelectionAction({
  sessionId,
  useSession,
  dismiss,
  readText,
  clearSelection,
  inputActions,
  startSideChat,
}: SideChatSelectionActionProps) {
  const writable = useSession(sideChatAvailable);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!writable) dismiss();
  }, [writable, dismiss]);
  const decision = sideSurfaceActions({ writable, readText });
  if (!decision.visible) return null;
  const quote = () => {
    if (busy) return;
    const text = readText();
    if (text === null) {
      dismiss();
      return;
    }
    // A refused insert keeps the surface: the draft did not take the text, so
    // clearing the selection would lose it.
    if (!inputActions.insertQuote(text)) return;
    clearSelection();
    dismiss();
  };
  const branch = () => {
    if (busy) return;
    const text = readText();
    if (text === null) {
      dismiss();
      return;
    }
    setBusy(true);
    setFailed(false);
    startSideChat(sessionId, text)
      .then(() => {
        clearSelection();
        dismiss();
      })
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className={styles.selectionAction}>
      <div className={styles.selectionButtons}>
        <button
          type="button"
          className={styles.selectionButton}
          disabled={busy || !decision.quoteEnabled}
          onPointerDown={(event) => {
            event.preventDefault();
          }}
          onClick={quote}
        >
          引用文本
        </button>
        <button
          type="button"
          className={styles.selectionButton}
          disabled={busy || !decision.sideChatEnabled}
          onPointerDown={(event) => {
            event.preventDefault();
          }}
          onClick={branch}
        >
          在侧边对话中引用
        </button>
      </div>
      {failed ? (
        <p className={styles.selectionError} role="alert">
          侧边对话创建失败，请重试
        </p>
      ) : null}
    </div>
  );
}

/**
 * Props of the assistant action, as the list entry composes them: the owner
 * currency (`messageId`), the standard session kit (`useSession`/`useChat`/
 * `sessionId`) and the entry-injected branch flow.
 */
export interface SideChatAssistantActionProps extends SideChatSessionFace {
  /** Durable id of the finalized assistant message owning this action row. */
  readonly messageId: string;
  readonly useChat: SideChatSelector;
  /** Entry-injected branch creation flow (fork + record + open tab). */
  readonly startSideChat: SideChatLauncher;
}

/**
 * Render 「在侧边对话中引用」 for one finalized assistant reply: the reply's
 * whole prose becomes the branch's quoted text (the same result as selecting
 * it). Renders nothing in an unwritable conversation or when the reply has no
 * quotable prose; a failed creation shows inline failure copy and stays
 * clickable for a retry.
 * @param props - assistant action props.
 * @returns the icon action and any inline failure, or null when unavailable.
 */
export function SideChatAssistantAction({
  sessionId,
  useSession,
  messageId,
  useChat,
  startSideChat,
}: SideChatAssistantActionProps) {
  const writable = useSession(sideChatAvailable);
  const quote = useChat((snapshot) => resolveAssistantQuote(snapshot.nodes.values(), messageId));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!writable || quote === null) return null;
  const begin = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    startSideChat(sessionId, quote)
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <>
      <button
        type="button"
        className={styles.assistantAction}
        aria-label="在侧边对话中引用"
        title="在侧边对话中引用"
        disabled={busy}
        onPointerDown={(event) => {
          event.preventDefault();
        }}
        onClick={begin}
      >
        <MessageCirclePlus size={17} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {failed ? (
        <span className={styles.assistantError} role="alert">
          侧边对话创建失败，请重试
        </span>
      ) : null}
    </>
  );
}

// --- Registration -----------------------------------------------------------

/**
 * Register the side-chat conversation entries: the synchronous interaction that
 * claims selection gestures with its two-button surface (the keyed
 * `conversation.chat.text-interaction` entry), and the per-reply assistant
 * action (a `conversation.chat.assistant-actions` entry).
 * @param ctx - client faces carrying the conversation interaction registry.
 * @param startSideChat - branch creation flow injected into both entries.
 * @returns cleanup unregistering the assistant action, then the surface, then
 * the interaction.
 */
export function registerSideInteraction(
  ctx: SideInteractionContext,
  startSideChat: SideChatLauncher,
): () => void {
  const disposeInteraction = ctx.uiConversation.interactions.register({
    id: SIDE_CHAT_INTERACTION_ID,
    onInteraction(request) {
      if (request.trigger !== 'selection' || request.readText() === null) return;
      const binding = ctx.sessions.binding?.(request.sessionId);
      if (binding !== undefined && !sideChatAvailable(binding.session.getSnapshot())) {
        return;
      }
      request.open();
    },
  });
  let disposeSurface: (() => void) | null = null;
  let disposeAssistant: (() => void) | null = null;
  ctx.slots.inject(SIDE_TEXT_INTERACTION_SLOT, () => {
    const dispose = ctx.slots.register(
      {
        name: SIDE_TEXT_INTERACTION_SLOT,
        key: SIDE_CHAT_INTERACTION_ID,
        inject: () => ({ startSideChat }),
      },
      SideChatSelectionAction,
    );
    disposeSurface = dispose;
    return dispose;
  });
  ctx.slots.inject(SIDE_ASSISTANT_ACTIONS_SLOT, () => {
    const dispose = ctx.slots.register(
      {
        name: SIDE_ASSISTANT_ACTIONS_SLOT,
        id: SIDE_ASSISTANT_ACTION_ID,
        order: SIDE_ASSISTANT_ACTION_ORDER,
        inject: () => ({ startSideChat }),
      },
      SideChatAssistantAction,
    );
    disposeAssistant = dispose;
    return dispose;
  });
  return () => {
    disposeAssistant?.();
    disposeSurface?.();
    disposeInteraction();
  };
}

/**
 * Tail of an id used as a display short id: the first 8 characters, which is
 * the leading group of a DSH session UUID.
 */
export function shortIdOf(id: string | null | undefined): string {
  if (id === null || id === undefined) return '';
  return id.slice(0, 8);
}

/**
 * Row/tab title of a side chat: the record's own title, else
 * 「侧边对话」 + the session (or record) short id.
 */
export function chatRowTitle(chat: Pick<Chat, 'title' | 'sessionId' | 'id'>): string {
  if (chat.title !== '') return chat.title;
  const short = shortIdOf(chat.sessionId ?? chat.id);
  return short === '' ? '侧边对话' : `侧边对话 ${short}`;
}

/**
 * Source label of a side chat: 「分支自《title》」 when the main conversation's
 * title is known, else the generic 「分支自主对话」 (records written before the
 * title was captured keep the generic copy).
 */
export function chatSourceLabel(
  chat: Pick<Chat, 'sideOf'> | undefined | null,
): string {
  const title = chat?.sideOf?.title ?? '';
  return title === '' ? '分支自主对话' : `分支自《${title}》`;
}
