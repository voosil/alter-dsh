/**
 * Side conversations (侧边对话): the right-sidebar tab type, its body, and the
 * resource provider that binds the tab to the branch's DSH session.
 *
 * Two-stage registration, exactly like the platform's own tab types:
 * `sidebarRightTabs.register` declares the page type (`alter-space.side`,
 * `multiple: true` — every open is an independent occurrence whose content id
 * is minted by the framework), and the keyed `sidebar.right.pane.tab` seat
 * renders the body under the type's id. The body reads the branch session id
 * from the navigation params and resolves it into a live session reference
 * through the `spacechat` resource protocol; a private session-scoped slot
 * rebinds the standard session hooks onto that reference so the shared
 * Conversation factory renders the branch conversation (embedded variant).
 *
 * The DSH faces are mirrored as local structural types (no runtime
 * `@deepseek-ai/*` imports); the derivation of `phase`/`hero` mirrors the
 * host's own Conversation panel so an embedded branch behaves like a main
 * conversation that is still replaying.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Chat } from '@alter/protocol';
import type { SideUnreadStore } from './side-status';
import { SIDE_CHAT_TAB_KIND, chatSourceLabel, type SideSessionSnapshot } from './side';
import {
  SIDE_CHAT_ORPHAN_ADDRESS,
  SIDE_CHAT_PATTERN,
  SIDE_CHAT_PROTOCOL,
  buildSpaceChatAddress,
  parseSpaceChatAddress,
} from './address';
import {
  registerTabBody,
  registerTabType,
  safeRegisterResource,
} from '../space-rightbar/register-body';
import styles from './side.module.css';

/** Tab type id; also the body registration key on the pane tab seat. */
export const SIDE_CHAT_TAB_TYPE_ID = '@alter-dsh/space/side-chat';

/** Private session-scoped slot the body rebinds onto the branch session. */
export const SIDE_CHAT_SESSION_SLOT = 'alter-space.side-chat.session';

/** Seat a tab type's body registers under. */
export const SIDE_TAB_BODY_SLOT = 'sidebar.right.pane.tab';

/** Re-exported address helpers so callers import them from one module. */
export {
  buildSpaceChatAddress,
  parseSpaceChatAddress,
  SIDE_CHAT_PROTOCOL,
} from './address';

/** Chip title of a side-chat tab, captured by the registry at open time. */
export function sideTabTitle(address: string): string {
  const sessionId = parseSpaceChatAddress(address);
  if (sessionId === undefined) return '侧边对话';
  return `侧边对话 ${sessionId.slice(0, 8)}`;
}

/** Resolve the branch session id a tab body was opened with. */
export function tabParamsSessionId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const candidate = (params as { sessionId?: unknown }).sessionId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
}

/** Resolves when the signal aborts; immediate for an already-aborted signal. */
export function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** A retained DSH session, as `sessions.retain` hands it out (structural). */
export interface SideSessionReference {
  readonly sessionId: string;
  readonly ready: Promise<unknown>;
  release(): void;
}

/** Faces the resource provider needs from the session service. */
export interface SideResourceSessions {
  retain(
    sessionId: string,
    options: { source: string; signal?: AbortSignal },
  ): SideSessionReference;
}

/** One frame of a resource stream, as the resource model consumes it. */
export type SideResourceFrame =
  | { ok: true; value: SideSessionReference }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Provider face `ctx.resources.register` accepts (structural). */
export interface SideResourceProvider {
  readonly protocol: string;
  open(address: string, ctx: { signal: AbortSignal }): AsyncIterable<SideResourceFrame>;
}

/**
 * Serve `spacechat` addresses: each open retains the branch session for as
 * long as the resource is held (the tab body's subscription or a pin), then
 * releases it when the stream aborts.
 */
export function createSpaceChatProvider(sessions: SideResourceSessions): SideResourceProvider {
  return {
    protocol: SIDE_CHAT_PROTOCOL,
    async *open(address, { signal }) {
      const sessionId = parseSpaceChatAddress(address);
      if (sessionId === undefined) {
        yield {
          ok: false,
          error: {
            code: 'gateway/internal',
            details: {},
            message: `malformed side-chat resource address: ${address}`,
          },
        };
        return;
      }
      let reference: SideSessionReference;
      try {
        reference = sessions.retain(sessionId, { source: 'spaceChatTab', signal });
      } catch (error) {
        yield {
          ok: false,
          error: {
            code: 'gateway/internal',
            details: {},
            message: error instanceof Error ? error.message : String(error),
          },
        };
        return;
      }
      try {
        yield { ok: true, value: reference };
        await waitForAbort(signal);
      } finally {
        reference.release();
      }
    },
  };
}

// --- Phase derivation (mirrors the host Conversation panel) ---------------

/** Shell phase of a conversation, as the host derives it from Session state. */
export type SideShellPhase = 'blank' | 'engaging' | 'active';

/** Render phase of the Conversation body. */
export type SideConversationPhase = 'settling' | 'hero' | 'active';

/** Everything the derivation reads, gathered so it stays a pure function. */
export interface SidePhaseInput {
  /** `undefined` when the conversation has no Session yet (hero). */
  readonly sessionId: string | undefined;
  readonly blank: boolean;
  readonly promptAttempted: boolean;
  readonly awaitingFirstTurn: boolean;
  readonly running: boolean;
  /** Whether any Conversation view target is active (streaming cards etc.). */
  readonly hasActiveTargets: boolean;
  readonly openState: 'cold' | 'loading' | 'open' | 'error' | undefined;
  /** The session list's blank verdict, when it has one. */
  readonly summaryBlank: boolean | undefined;
}

/** Shell phase from Session lifecycle and registered target activity. */
export function sideShellPhase(input: {
  blank: boolean;
  promptAttempted: boolean;
  awaitingFirstTurn: boolean;
  running: boolean;
  hasActiveTargets: boolean;
}): SideShellPhase {
  const active = input.hasActiveTargets
    || (!input.blank && !input.awaitingFirstTurn)
    || input.running;
  if (active) return 'active';
  return input.promptAttempted ? 'engaging' : 'blank';
}

/**
 * Whether the body renders the centered hero, the settling placeholder, or
 * the active transcript. While a branch is still replaying (loading + blank)
 * the hero/docked choice is unknowable — hide the composer instead of
 * flashing — unless the list summary already proves the session blank, in
 * which case it can only land on the hero.
 */
export function deriveSidePhase(input: SidePhaseInput): SideConversationPhase {
  const shellPhase = sideShellPhase(input);
  const settling = input.sessionId !== undefined
    && shellPhase === 'blank'
    && input.openState === 'loading'
    && input.summaryBlank !== true;
  const hero = input.sessionId === undefined
    || (shellPhase === 'blank' && (input.openState === 'open' || input.summaryBlank === true));
  return settling ? 'settling' : hero ? 'hero' : 'active';
}

// --- Structural faces of the tab seat --------------------------------------

/** Tab information `useTabInfo` reads for one body occurrence (structural). */
export interface SideTabInfo {
  readonly tab: {
    readonly id: string;
    readonly kind: string;
    readonly contentId: string;
    readonly title: string;
    readonly visible: boolean;
    readonly navigation: {
      readonly address: string;
      readonly params: unknown;
      readonly revision: number;
    };
    readonly signal: AbortSignal;
  };
}

/** Hook the `sidebar.right.pane.tab` seat injects into every body. */
export type UseSideTabInfo = () => SideTabInfo;

/** Live state of one resource address, as `useResource` returns it. */
export interface SideResourceSnapshot<Value> {
  readonly status: 'none' | 'loading' | 'live' | 'failed';
  readonly value: Value | undefined;
  readonly failure: { code: string; message: string } | undefined;
}

/** Session list snapshot slice the phase derivation reads. */
export interface SideSessionsListSnapshot {
  readonly byId: Record<string, { blank: boolean } | undefined>;
}

/** Conversation snapshot slice the phase derivation reads. */
export interface SideConversationSnapshot {
  readonly activeTargets: ReadonlySet<string>;
}

/** Factory input of the reusable Conversation body (structural). */
export interface SideConversationContentInput {
  readonly variant: 'main' | 'embedded';
  readonly phase: SideConversationPhase;
  readonly hero: boolean;
}

/** Slot renderer the framework binds for declared children. */
export type SideRenderSlot = (
  name: string,
  owner: Record<string, unknown>,
) => ReactNode;

/** Component the Conversation factory accepts as its `views` local slot. */
export type SideChatViewComponent = (props: FixedChatViewProps) => ReactNode;

/** Factory renderer every slot entry receives, narrowed to what we call. */
export interface SideRenderFactorySlot {
  (
    name: 'conversation.content',
    input: SideConversationContentInput,
    options?: { slots?: { views?: SideChatViewComponent } },
  ): ReactNode;
}

/** Session-scoped renderer the factory's `views` local slot replaces. */
export interface FixedChatViewProps {
  readonly renderSlot: (name: 'conversation.session', owner: { view?: string }) => ReactNode;
}

/** Render the Chat view only: an embedded branch always shows the transcript. */
export function FixedChatView({ renderSlot }: FixedChatViewProps): ReactNode {
  return renderSlot('conversation.session', { view: 'chat' });
}

/** Props of the tab body, as the keyed seat composes them. */
export interface SideChatTabProps {
  readonly useTabInfo: UseSideTabInfo;
  readonly useResource: (address: string) => SideResourceSnapshot<unknown>;
  readonly SessionProvider: (
    props: {
      session: SideSessionReference;
      children: ReactNode;
    },
  ) => ReactNode;
  readonly renderSlot: SideRenderSlot;
}

/** Store slice the branch banner reads; injected by `registerSideChatTab`. */
export interface SideChatStoreSource {
  chatSourceOfSession(sessionId: string): {
    getSnapshot(): Chat | undefined;
    subscribe(listener: () => void): () => void;
  };
  /**
   * Unread branches (registration-injected; absent on a boot without the status
   * service, which marks nothing and acknowledges nothing).
   */
  unread?: SideUnreadStore;
}

let sideTabStore: SideChatStoreSource | null = null;

/** Stable empty set, so a boot without the tracker keeps one snapshot identity. */
const NO_UNREAD: ReadonlySet<string> = new Set();

/** Unread branches of the running registration (empty without the tracker). */
function useUnreadIds(): ReadonlySet<string> {
  const subscribe = useCallback(
    (listener: () => void) => sideTabStore?.unread?.subscribe(listener) ?? (() => undefined),
    [],
  );
  return useSyncExternalStore(
    subscribe,
    () => sideTabStore?.unread?.getSnapshot() ?? NO_UNREAD,
    () => NO_UNREAD,
  );
}

/** Chat record bound to one side-chat session, read through the chat store. */
function useSideChatOfSession(sessionId: string | undefined): Chat | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = sideTabStore;
      if (store === null || sessionId === undefined) return () => undefined;
      return store.chatSourceOfSession(sessionId).subscribe(listener);
    },
    [sessionId],
  );
  return useSyncExternalStore(
    subscribe,
    () => sideTabStore?.chatSourceOfSession(sessionId ?? '').getSnapshot(),
    () => undefined,
  );
}

/**
 * One side-chat tab's body: the branch banner over the embedded conversation.
 * The session reference arrives through the `spacechat` resource; without it
 * (still loading, or a tab whose navigation params were lost on reload) the
 * body shows the banner over a short notice instead of a dead conversation.
 */
export function SideChatTab({
  useTabInfo,
  useResource,
  SessionProvider,
  renderSlot,
}: SideChatTabProps): ReactNode {
  const info = useTabInfo();
  // A resource tab keeps its session in the content id, so a layout restored
  // after reload still resolves; params stay as the fallback for a tab opened
  // by an older build.
  const sessionId = parseSpaceChatAddress(info.tab.contentId)
    ?? tabParamsSessionId(info.tab.navigation.params);
  const address = sessionId === undefined
    ? SIDE_CHAT_ORPHAN_ADDRESS
    : buildSpaceChatAddress(sessionId);
  const resource = useResource(address);
  const chat = useSideChatOfSession(sessionId);
  const reference = resource.status === 'live'
    ? (resource.value as SideSessionReference | undefined)
    : undefined;
  // A visible tab is the user looking at the branch, which is exactly what the
  // history row's 「已完成」 marker waits for. The seat republishes `visible`
  // when the column expands, collapses or switches tabs, and the unread set
  // republishes on every completion, so this clears both a completion that
  // landed while the column was collapsed and one that landed while the tab was
  // in front of the user.
  const visible = info.tab.visible;
  const unreadIds = useUnreadIds();
  useEffect(() => {
    if (!visible || sessionId === undefined) return;
    if (!unreadIds.has(sessionId)) return;
    sideTabStore?.unread?.acknowledge(sessionId);
  }, [visible, sessionId, unreadIds]);
  return (
    <div className={styles.tabBody} data-side-chat-body="">
      <div className={styles.banner} data-side-chat-banner="">
        {chatSourceLabel(chat)}
      </div>
      <div className={styles.chatArea}>
        {reference !== undefined ? (
          <SessionProvider session={reference}>
            {renderSlot(SIDE_CHAT_SESSION_SLOT, {})}
          </SessionProvider>
        ) : resource.status === 'failed' ? (
          <p className={styles.notice}>
            侧边对话暂时无法打开，请从「侧边对话历史」重新打开。
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Props of the branch conversation body, bound to the overridden session. */
export interface SideChatSessionBodyProps {
  readonly sessionId: string;
  readonly useSession: <T>(selector: (snapshot: SideSessionSnapshot) => T) => T;
  readonly useConversation: <T>(
    selector: (snapshot: SideConversationSnapshot) => T,
  ) => T;
  readonly useSessions: <T>(
    selector: (list: SideSessionsListSnapshot) => T,
  ) => T;
  readonly inputActions: { insertQuote(text: string): boolean };
  readonly renderFactorySlot: SideRenderFactorySlot;
}

/** Branch sessions whose quote has already been attempted (insert once). */
const QUOTE_ATTEMPTED = new Set<string>();

/**
 * The branch conversation: the shared Conversation factory in its embedded
 * variant, with the Chat view fixed in. The first mount carries the quoted
 * selection into the branch composer (once per session, silently skipped
 * while the composer is not in its plain phase).
 */
export function SideChatSessionBody({
  sessionId,
  useSession,
  useConversation,
  useSessions,
  inputActions,
  renderFactorySlot,
}: SideChatSessionBodyProps): ReactNode {
  const session = useSession((snapshot) => snapshot);
  const conversation = useConversation((snapshot) => snapshot);
  const summaryBlank = useSessions(
    (list) => list.byId[session.sessionId]?.blank,
  );
  const chat = useSideChatOfSession(sessionId);
  const quote = chat?.quote ?? null;
  useEffect(() => {
    if (quote === null || quote === '') return;
    if (QUOTE_ATTEMPTED.has(sessionId)) return;
    QUOTE_ATTEMPTED.add(sessionId);
    // A non-plain composer refuses the insert; unmark so a fresh body may try
    // again rather than dropping the quote forever.
    if (!inputActions.insertQuote(quote)) QUOTE_ATTEMPTED.delete(sessionId);
  }, [quote, sessionId, inputActions]);
  const phase = deriveSidePhase({
    sessionId: session.sessionId,
    blank: session.blank,
    promptAttempted: session.promptAttempted,
    awaitingFirstTurn: session.awaitingFirstTurn,
    running: session.running,
    hasActiveTargets: conversation.activeTargets.size > 0,
    openState: session.openState,
    summaryBlank,
  });
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase, hero: phase === 'hero' },
    { slots: { views: FixedChatView } },
  );
}

/** Faces `registerSideChatTab` needs (structural). */
export interface SideChatTabContext {
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  readonly sessions: SideResourceSessions;
  readonly sidebarRightTabs: {
    register(definition: {
      readonly id: string;
      readonly kind: string;
      readonly priority: 'extension' | 'builtin' | 'fallback';
      readonly patterns?: readonly string[];
      readonly canOpen?: (address: string) => boolean;
      readonly multiple?: boolean;
      readonly keepMounted?: boolean;
      readonly title: (address: string) => string;
    }): () => void;
  };
  readonly resources: {
    register(provider: SideResourceProvider): () => void;
  };
  /** Unread tracker, acknowledged while a branch tab is visible. */
  readonly unread?: SideUnreadStore;
}

/**
 * Register the side-chat tab: resource protocol, tab type, and the body with
 * its private session slot. @param ctx - client faces carrying the tab registry.
 * @param store - chat store the branch banner reads.
 * @returns cleanup tearing the body down before the type and the provider.
 */
export function registerSideChatTab(
  ctx: SideChatTabContext,
  store: SideChatStoreSource,
): () => void {
  sideTabStore = { ...store, unread: ctx.unread };
  // A reload can leave the previous instance's provider in place; the
  // tab body is what the seat dispatches, so a refused provider must not
  // stop it from registering.
  const disposeProvider = safeRegisterResource(ctx, () =>
    createSpaceChatProvider(ctx.sessions),
  );
  const disposeType = registerTabType(ctx.sidebarRightTabs, {
    id: SIDE_CHAT_TAB_TYPE_ID,
    kind: SIDE_CHAT_TAB_KIND,
    patterns: [SIDE_CHAT_PATTERN],
    canOpen: (address: string) => parseSpaceChatAddress(address) !== undefined,
    priority: 'extension',
    keepMounted: true,
    title: sideTabTitle,
  });
  // The seat belongs to the right-Sidebar plugin: the helper registers eagerly
  // when the slot is already declared and keeps an inject subscription for the
  // case where it appears later (or was re-declared by a module reload).
  const disposeBody = registerTabBody(
    ctx,
    SIDE_TAB_BODY_SLOT,
    SIDE_CHAT_TAB_TYPE_ID,
    SideChatTab as never,
    { [SIDE_CHAT_SESSION_SLOT]: { kind: 'single', scope: 'session' } },
  );
  // The private child slot is declared by the body above, so it is injected the
  // same way (waiting for that declaration rather than assuming it).
  const disposeSession = ctx.slots.inject(SIDE_CHAT_SESSION_SLOT, () => ctx.slots.register(
    { name: SIDE_CHAT_SESSION_SLOT },
    SideChatSessionBody,
  ));
  return () => {
    disposeSession();
    disposeBody();
    disposeType();
    disposeProvider();
    sideTabStore = null;
  };
}
