/**
 * 「新建对话」orchestration for the right-sidebar Space tab.
 *
 * The tab's guide bar offers one primary action: create a conversation that
 * auto-references whatever the Space UI is showing. A page target references
 * that page (the ref carries its id and its *current* title); anything else
 * falls back to a space-only reference (the ref carries the space name). The
 * flow is split into three seams so it is unit-testable without React or DSH:
 *
 * - `currentTabTarget` reduces the tab's private route to an open target.
 * - `resolveAutoRef` turns that target into the reference a new chat carries.
 * - `runNewChat` runs the whole flow (resolve → create → open) and never
 *   rejects: failures are reported through `onError` for inline display, never
 *   as a toast.
 * - `createNewChatRunner` dedupes concurrent clicks so a double click creates
 *   exactly one conversation.
 *
 * Everything the DSH side owns arrives by injection. `newChatBridge` reads the
 * vendor bridge structurally (it is installed by the plugin assembly and may be
 * absent in tests), so this module never imports a runtime capability. A
 * space-only reference passes `nodeId: null`; `openSessionAside` is the
 * assembly seam that opens the conversation beside the page, and its absence
 * falls back to the main-view opener.
 */
import { parseSpaceRoute } from '@alter/ui-space/space-route';
import { parseSpacePageParams, type SpacePageTabParams } from './tab-router';

/** Inline failure copy; the required copy is the prefix, the reason is optional. */
export const NEW_CHAT_FAILED = '对话创建失败，请重试';
/** Inline copy when the tab has no space or page to reference. */
export const NEW_CHAT_NO_TARGET = '当前标签页没有可引用的空间页面';
/** Inline copy when the conversation exists but could not be shown. */
export const NEW_CHAT_OPEN_FAILED = '对话已创建，但没能在右侧打开';
/** Inline copy when the bridge does not expose conversation creation. */
export const NEW_CHAT_UNAVAILABLE = '空间对话服务不可用，暂时无法新建对话';

/** The reference one new conversation carries: a page, or the space itself. */
export interface NewChatRef {
  spaceId: string;
  /** `null` when the conversation is about the space rather than one page. */
  nodeId: string | null;
  /** Current page title, or the space name for a space-only reference. */
  nodeTitle: string;
}

/** Lookups the reference resolution needs; both are optional and may fail. */
export interface AutoRefDeps {
  /** Title of one page; `undefined` when the node no longer exists. */
  getNode?: (nodeId: string) => Promise<{ title?: string } | undefined>;
  /** Display name of a space, used as the title of a space-only reference. */
  getSpaceName?: (spaceId: string) => Promise<string | undefined>;
}

/**
 * Open target of the tab's private route.
 *
 * `SpaceApp` keeps that router as its own state, so the route is the
 * authoritative answer to "what is on screen": a document route is a page
 * target and every other space view (overview/thoughts/config/…) is a space
 * target. The opening params only seed the initial route
 * (`initialSpacePageTabPath`), which is why callers may still pass them as a
 * fallback before the app has navigated.
 */
export function currentTabTarget(path: string): SpacePageTabParams {
  const route = parseSpaceRoute(path);
  if (route.spaceId === undefined) return {};
  if (route.view === 'doc' && route.id !== undefined) {
    return { spaceId: route.spaceId, nodeId: route.id };
  }
  return { spaceId: route.spaceId };
}

/**
 * Target a guide-created conversation references.
 *
 * The guide entry sits in the right column, whose left side is the Space main
 * panel; that panel's route is the authoritative answer to "what is the reader
 * looking at". The route is only meaningful while that panel is the active main
 * panel — on a conversation page the right column has no space beside it, so
 * nothing is referenced ({@link NewChatTab} then falls back to the default
 * space, the entry's own contract).
 * @param path - the Space main panel's last route.
 * @param mainPanelActive - whether the Space panel fills the centre right now.
 * @returns the target, or `{}` when there is no space beside the column.
 */
export function guideTargetOf(
  path: string,
  mainPanelActive: boolean,
): SpacePageTabParams {
  if (!mainPanelActive) return {};
  return currentTabTarget(path);
}

/**
 * Resolve the reference a new conversation auto-carries.
 *
 * A page target references the page by its current title; a page that is gone
 * (or has no title) degrades to a space target, which keeps the conversation
 * anchored on something that still exists. No space target at all resolves to
 * `null` — nothing can be referenced, so the caller must not create a chat.
 */
export async function resolveAutoRef(
  params: unknown,
  deps: AutoRefDeps = {},
): Promise<NewChatRef | null> {
  const target = parseSpacePageParams(params);
  const spaceId = target.spaceId;
  if (spaceId === undefined) return null;
  const nodeId = target.nodeId;
  if (nodeId !== undefined) {
    const nodeTitle = await readTitle(
      async () => (await deps.getNode?.(nodeId))?.title,
    );
    if (nodeTitle !== null) return { spaceId, nodeId, nodeTitle };
  }
  const spaceName = await readTitle(async () => deps.getSpaceName?.(spaceId));
  return { spaceId, nodeId: null, nodeTitle: spaceName ?? spaceId };
}

/** Injected surface of `runNewChat`; the tab body wires the real bridge. */
export interface NewChatDeps extends AutoRefDeps {
  /** The tab's current target (route-derived, or the opening params). */
  params: unknown;
  /** Create the conversation around one reference; rejects with a message. */
  startPageChat: (ref: NewChatRef) => Promise<{ sessionId: string | null }>;
  /** Open the new conversation in the right sidebar (assembly-provided). */
  openAside?: (sessionId: string) => void;
  /** Main-view opener, used only when no sidebar capability is injected. */
  openMain?: (sessionId: string) => void;
  /** Receive inline failure copy (the caller renders it; never a toast). */
  onError?: (message: string) => void;
}

/**
 * Create the conversation, reference the current page/space and open it.
 *
 * Resolves to `'ok'` or `'failed'` and never rejects: failures are reported
 * through `onError` with copy suitable for the inline error next to the
 * button. The right sidebar itself is never navigated — the tab keeps the page
 * it shows; only the conversation's surface is opened (`openAside`, else
 * `openMain`, else nothing because `startPageChat` already opened it).
 */
export async function runNewChat(deps: NewChatDeps): Promise<'ok' | 'failed'> {
  const report = (message: string) => deps.onError?.(message);
  const ref = await resolveAutoRef(deps.params, deps);
  if (ref === null) {
    report(NEW_CHAT_NO_TARGET);
    return 'failed';
  }
  let sessionId: string | null;
  try {
    const created = await deps.startPageChat(ref);
    sessionId = sessionIdOf(created?.sessionId);
  } catch (error) {
    report(failureMessage(error));
    return 'failed';
  }
  if (sessionId === null) {
    report(NEW_CHAT_FAILED);
    return 'failed';
  }
  try {
    if (deps.openAside !== undefined) deps.openAside(sessionId);
    else deps.openMain?.(sessionId);
  } catch {
    // The conversation exists; only its surface is missing. Say so inline
    // instead of pretending the whole action failed.
    report(NEW_CHAT_OPEN_FAILED);
  }
  return 'ok';
}

/** Duplicate-click guard around `runNewChat`; one instance per tab. */
export interface NewChatRunner {
  /** A call is in flight (the button shows 「创建中…」 and stays disabled). */
  readonly pending: boolean;
  /** Run the flow, or reuse the in-flight one when a click lands mid-flight. */
  run(deps: NewChatDeps): Promise<'ok' | 'failed'>;
}

/** Create the per-tab runner; concurrent clicks share one conversation. */
export function createNewChatRunner(): NewChatRunner {
  let inFlight: Promise<'ok' | 'failed'> | null = null;
  return {
    get pending() {
      return inFlight !== null;
    },
    run(deps) {
      if (inFlight !== null) return inFlight;
      const task = runNewChat(deps).finally(() => {
        inFlight = null;
      });
      inFlight = task;
      return task;
    },
  };
}

/**
 * The bridge capability this module needs.
 *
 * `startPageChat` must accept `nodeId: null` for a space-only reference (the
 * runtime path already does); `openSessionAside` is the optional assembly seam
 * that opens a conversation beside the page instead of navigating the main
 * view.
 */
export interface NewChatBridge {
  startPageChat(ref: NewChatRef): Promise<{ sessionId: string | null }>;
  openSessionAside?(sessionId: string): void;
}

/** What this module requires of the installed bridge (structurally read). */
interface BridgeSource {
  startPageChat?(ref: {
    spaceId: string;
    nodeId: string | null;
    nodeTitle: string;
    /** Where the conversation opens; the sidebar entry asks for `aside`. */
    open?: 'main' | 'aside';
  }): Promise<{ sessionId: string | null }>;
  openSessionAside?(sessionId: string): void;
}

/**
 * Read the conversation capability off the vendor bridge.
 *
 * `null` when the bridge is absent or does not expose `startPageChat` (tests,
 * partial boot): the caller disables the button and explains why.
 */
export function newChatBridge(source: unknown): NewChatBridge | null {
  if (typeof source !== 'object' || source === null) return null;
  const startPageChat = (source as BridgeSource).startPageChat;
  if (typeof startPageChat !== 'function') return null;
  const openSessionAside = (source as BridgeSource).openSessionAside;
  const bridge: NewChatBridge = {
    // `open: 'aside'` keeps the space main view untouched: the entry's whole
    // point is asking beside the page you are reading.
    startPageChat: (ref) =>
      startPageChat.call(source, { ...ref, open: 'aside' as const }),
  };
  if (typeof openSessionAside === 'function') {
    bridge.openSessionAside = (sessionId) => {
      openSessionAside.call(source, sessionId);
    };
  }
  return bridge;
}

/** Run one optional lookup; a throw or an empty answer is "no title". */
async function readTitle(
  read: () => Promise<string | undefined> | undefined,
): Promise<string | null> {
  try {
    const value = await read();
    const title = typeof value === 'string' ? value.trim() : '';
    return title === '' ? null : title;
  } catch {
    return null;
  }
}

/** Normalise a bridge session id; a missing one cannot be opened. */
function sessionIdOf(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Inline copy for a failed creation: required prefix, optional reason. */
function failureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message.trim() : '';
  if (reason === '') return NEW_CHAT_FAILED;
  if (reason.startsWith(NEW_CHAT_FAILED)) return reason;
  return `${NEW_CHAT_FAILED}（${reason}）`;
}
