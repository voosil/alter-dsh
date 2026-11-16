/**
 * Right-sidebar tab that hosts one ordinary DSH session (a page conversation).
 *
 * Page conversations must be readable beside the page they talk about, so they
 * need the same embedding the side-chat tab got — but they are *ordinary*
 * sessions, not branches. This module owns that second resource type:
 *
 * - the address carries the session id, so a sidebar layout restored after a
 *   reload reopens the same conversation;
 * - DSH allows one editable root per session, so the plugin opens a page
 *   conversation in exactly one place at a time.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Split } from 'lucide-react';
import type {
  SideResourceFrame,
  SideResourceProvider,
  SideResourceSessions,
} from './side-tab';
import type { SideSessionSnapshot } from './side';
import {
  registerTabBody,
  registerTabType,
  safeRegisterResource,
} from '../space-rightbar/register-body';
import styles from './side.module.css';

/** Resource protocol of a page-conversation session tab. */
export const SESSION_TAB_PROTOCOL = 'spacesession';

/** Prefix every page-conversation address starts with. */
export const SESSION_TAB_ADDRESS_PREFIX = `dsh-resource://${SESSION_TAB_PROTOCOL}/session/`;

/** Glob the resource tab type claims page-conversation addresses with. */
export const SESSION_TAB_PATTERN = `${SESSION_TAB_ADDRESS_PREFIX}**`;

/** Tab type id; also the body registration key on the pane tab seat. */
export const SESSION_TAB_TYPE_ID = '@alter-dsh/space/session';

/** Kind the navigation controller names when it opens one. */
export const SESSION_TAB_KIND = 'alter-space.session';

/** Seat a tab type's body registers under. */
const TAB_BODY_SLOT = 'sidebar.right.pane.tab';

/** Private session-scoped slot the outer tab fills with the conversation. */
const SESSION_SLOT = 'alter-space.session-tab.session';

/**
 * Address of one page-conversation resource.
 * @param sessionId - DSH session id.
 * @returns the canonical resource address.
 */
export function buildSessionTabAddress(sessionId: string): string {
  return `${SESSION_TAB_ADDRESS_PREFIX}${encodeURIComponent(sessionId)}`;
}

/**
 * Parse a page-conversation resource address.
 * @param address - any address.
 * @returns the session id, or `undefined` for anything else.
 */
export function parseSessionTabAddress(
  address: string,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'dsh-resource:') return undefined;
  if (parsed.hostname.toLowerCase() !== SESSION_TAB_PROTOCOL) return undefined;
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 2 || segments[0] !== 'session') return undefined;
  try {
    const sessionId = decodeURIComponent(segments[1]);
    return sessionId === '' ? undefined : sessionId;
  } catch {
    return undefined;
  }
}

/** Chip title of a page-conversation tab, captured at open time. */
export function sessionTabTitle(address: string): string {
  const sessionId = parseSessionTabAddress(address);
  return sessionId === undefined ? '对话' : `对话 ${sessionId.slice(0, 8)}`;
}

/** Resolves when the signal aborts; immediate for an already-aborted signal. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Serve page-conversation addresses: each open retains the session for as long
 * as the resource is held, then releases it when the stream aborts.
 * @param sessions - session service face.
 * @returns the resource provider.
 */
export function createSessionTabProvider(
  sessions: SideResourceSessions,
): SideResourceProvider {
  return {
    protocol: SESSION_TAB_PROTOCOL,
    async *open(address, { signal }): AsyncIterable<SideResourceFrame> {
      const sessionId = parseSessionTabAddress(address);
      if (sessionId === undefined) {
        yield {
          ok: false,
          error: {
            code: 'gateway/internal',
            details: {},
            message: `malformed session resource address: ${address}`,
          },
        };
        return;
      }
      let reference;
      try {
        reference = sessions.retain(sessionId, {
          source: 'spaceSessionTab',
          signal,
        });
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

/** One retainable session reference, as the resource carries it. */
/** Branch-creation flow the tab's toolbar drives; absent before assembly wires it. */
export type SessionTabBranch = (
  sessionId: string,
  quote?: string | null,
) => Promise<string>;

let branch: SessionTabBranch | null = null;

/**
 * Install the branch flow the tab toolbar uses.
 * @param next - the launcher, or null on unload.
 * @returns the previous value (tests may swap).
 */
export function setSessionTabBranch(next: SessionTabBranch | null): SessionTabBranch | null {
  const previous = branch;
  branch = next;
  return previous;
}

interface SessionTabReference {
  readonly sessionId: string;
  release(): void;
}

/** Live state of one resource address, as `useResource` returns it. */
interface ResourceSnapshot {
  readonly status: string;
  readonly value?: unknown;
}

/**
 * Toolbar above an embedded conversation.
 *
 * 「侧边对话」 branches the conversation the tab shows: the launcher forks it,
 * records the branch and opens it as its own tab beside this one. The tab keeps
 * its own conversation mounted, which is the point of reading it here.
 * @param props - the conversation the tab shows.
 * @returns the toolbar.
 */
function SessionTabBar({ sessionId }: { sessionId: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const start = () => {
    const launch = branch;
    if (launch === null || busy) return;
    setBusy(true);
    setFailed(false);
    void launch(sessionId)
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className={styles.tabBar} data-space-session-bar="">
      <button
        type="button"
        className={styles.branchButton}
        disabled={busy || branch === null}
        onClick={start}
      >
        <Split size={13} strokeWidth={1.7} aria-hidden="true" />
        {busy ? '创建中…' : '侧边对话'}
      </button>
      {failed ? (
        <span role="alert" className={styles.branchError}>
          侧边对话创建失败，请重试
        </span>
      ) : null}
    </div>
  );
}

/** Fixed Chat selection used by an embedded Conversation occurrence. */
function FixedChatView({
  renderSlot,
}: {
  renderSlot: (name: string, props: object) => ReactNode;
}): ReactNode {
  return renderSlot('conversation.session', { view: 'chat' });
}

/** Props of the keyed tab body (injected by the pane tab seat). */
export interface SessionTabProps {
  readonly useTabInfo: () => { readonly tab: { readonly contentId: string } };
  readonly useResource: (address: string) => ResourceSnapshot;
  readonly SessionProvider: (props: {
    session: unknown;
    children: ReactNode;
  }) => ReactNode;
  readonly renderSlot: (name: string, props: object) => ReactNode;
}

/**
 * Outer tab body: resolve the session from the record's content id, retain it
 * through the resource, and hand the bound conversation to the inner body.
 * @param props - pane tab injection.
 * @returns the embedded conversation, a loading hole, or a failure notice.
 */
export function SessionTab({
  useTabInfo,
  useResource,
  SessionProvider,
  renderSlot,
}: SessionTabProps): ReactNode {
  const info = useTabInfo();
  const address = info.tab.contentId;
  const sessionId = parseSessionTabAddress(address);
  const resource = useResource(address);
  const live =
    resource.status === 'live'
      ? (resource.value as SessionTabReference | undefined)
      : undefined;
  if (sessionId === undefined) {
    return (
      <p className={styles.notice}>
        该对话已不可用，请从左侧会话列表重新打开。
      </p>
    );
  }
  if (live === undefined) {
    return resource.status === 'failed' ? (
      <p className={styles.notice}>对话暂时无法打开，请重试。</p>
    ) : (
      <div className={styles.chatArea} aria-busy="true" />
    );
  }
  return (
    <div className={styles.tabBody} data-space-session-tab="">
      <SessionTabBar sessionId={sessionId} />
      <div className={styles.chatArea}>
        <SessionProvider session={live}>
          {renderSlot(SESSION_SLOT, {})}
        </SessionProvider>
      </div>
    </div>
  );
}

/** Props of the inner body, bound to the retained session. */
export interface SessionTabConversationProps {
  readonly sessionId: string;
  readonly useSession: <T>(selector: (snapshot: SideSessionSnapshot) => T) => T;
  readonly useConversation: <T>(
    selector: (snapshot: { readonly activeTargets: ReadonlySet<string> }) => T,
  ) => T;
  readonly renderFactorySlot: (
    name: string,
    input: { variant: 'embedded'; phase: string; hero: boolean },
    options: { slots: Record<string, unknown> },
  ) => ReactNode;
}

/**
 * Inner body: the shared Conversation factory in its embedded variant with the
 * Chat view fixed in. The phase mirrors the host panel so a blank session shows
 * the same hero/settling states it shows in the main column.
 * @param props - session-scope injection.
 * @returns the Conversation occurrence.
 */
export function SessionTabConversation({
  useSession,
  useConversation,
  renderFactorySlot,
}: SessionTabConversationProps): ReactNode {
  const session = useSession((snapshot) => snapshot);
  const conversation = useConversation((snapshot) => snapshot);
  const active =
    conversation.activeTargets.size > 0 ||
    (!session.blank && !session.awaitingFirstTurn) ||
    session.running;
  const phase = active
    ? 'active'
    : session.openState === 'loading' && !session.blank
      ? 'settling'
      : session.promptAttempted
        ? 'active'
        : 'hero';
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase, hero: phase === 'hero' },
    { slots: { views: FixedChatView } },
  );
}

/** Faces `registerSpaceSessionTab` needs (structural). */
export interface SessionTabContext {
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  readonly sessions: SideResourceSessions;
  readonly sidebarRightTabs: {
    register(definition: {
      readonly id: string;
      readonly kind: string;
      readonly patterns?: readonly string[];
      readonly canOpen?: (address: string) => boolean;
      readonly priority: 'extension' | 'builtin' | 'fallback';
      readonly keepMounted?: boolean;
      readonly title: (address: string) => string;
    }): () => void;
  };
  readonly resources: {
    register(provider: SideResourceProvider): () => void;
  };
}

/**
 * Register the page-conversation tab: resource protocol, tab type, outer body
 * and its private conversation slot.
 * @param ctx - client faces carrying the registries.
 * @returns cleanup tearing the bodies down before the type and the provider.
 */
export function registerSpaceSessionTab(ctx: SessionTabContext): () => void {
  // A reload can leave the previous instance's provider in place; the tab
  // body is what the seat dispatches, so a refused provider must not stop
  // it from registering.
  const disposeProvider = safeRegisterResource(ctx, () =>
    createSessionTabProvider(ctx.sessions),
  );
  const disposeType = registerTabType(ctx.sidebarRightTabs, {
    id: SESSION_TAB_TYPE_ID,
    kind: SESSION_TAB_KIND,
    patterns: [SESSION_TAB_PATTERN],
    canOpen: (address: string) => parseSessionTabAddress(address) !== undefined,
    priority: 'extension',
    keepMounted: true,
    title: sessionTabTitle,
  });
  // The body declares its private conversation child, and registers through
  // the resilient helper: a foreign seat may become declared after apply, and a
  // reload can leave the type registered by an earlier module instance.
  const disposeBody = registerTabBody(
    ctx,
    TAB_BODY_SLOT,
    SESSION_TAB_TYPE_ID,
    SessionTab as never,
    { [SESSION_SLOT]: { kind: 'single', scope: 'session' } },
  );
  const disposeConversation = ctx.slots.inject(SESSION_SLOT, () => ctx.slots.register(
    { name: SESSION_SLOT },
    SessionTabConversation,
  ));
  return () => {
    disposeConversation();
    disposeBody();
    disposeType();
    disposeProvider();
  };
}
