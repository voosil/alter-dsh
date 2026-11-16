/**
 * Right-sidebar activation for the Space surfaces.
 *
 * The column is DSH's own right Sidebar. Upstream it draws only the Session the
 * Conversation shows (`RightbarRoot`: `activePanelId === null`), so it has no
 * surface beside a plugin main panel. This build runs with the profile-level
 * override in `overrides/rightbar`, which names the *selected* Session no matter
 * which main panel is active; the column therefore exists beside the Space panel
 * too, drawing that Session's tabs (空间页面 / 对话 / 侧边对话).
 *
 * What remains the plugin's business: the column needs a Session on screen at
 * all. On a fresh window none is selected, so the switch resolves one through
 * the workspace flow first (without navigating away from the Space panel) and
 * reports `engaged`. When nothing can be resolved it reports `unavailable` so
 * the surface explains itself inline instead of doing nothing.
 */
import type { DshSessionId, SpaceClientContext } from './dsh';
import { workspaceOfSpace } from './dsh';

/** What the caller asked the right column to show. */
export interface RightbarRequest {
  /** Page to open beside the conversation, when the caller knows one. */
  spaceId?: string;
  nodeId?: string | null;
  /** Whether to also open the page tab (default true when `spaceId` is set). */
  openPage?: boolean;
  /**
   * Expand a collapsed column without ever collapsing an open one. Opening a
   * tab is "show me this", not "toggle": the same column can already be open
   * for another surface, and a second toggle would close it.
   */
  expandOnly?: boolean;
}

/** Outcome of one activation attempt. */
export type RightbarOutcome =
  /** The column was available and toggled. */
  | 'toggled'
  /** A Session had to be resolved first; the column is now expanded. */
  | 'engaged'
  /** Nothing could be shown; the surface reports it inline. */
  | 'unavailable';

/** Whether the right column currently has a Session behind it. */
export function rightbarAvailable(ctx: SpaceClientContext): boolean {
  const mounted = ctx.sidebarRight.mounted;
  return mounted !== undefined && mounted.getSnapshot() !== undefined;
}

/**
 * Toggle the right column beside whatever fills the centre, opening a page tab
 * when the caller named one.
 * @param ctx - client context carrying the layout, workspace, and sidebar faces.
 * @param request - the page to place beside the reader.
 * @returns what happened, for the caller's inline feedback.
 */
export async function toggleSpaceRightbar(
  ctx: SpaceClientContext,
  request: RightbarRequest = {},
): Promise<RightbarOutcome> {
  if (rightbarAvailable(ctx)) {
    try {
      showColumn(ctx, request);
      if (shouldOpenPage(request)) openPage(ctx, request);
      return 'toggled';
    } catch {
      return 'unavailable';
    }
  }
  // No Session is on screen at all: resolve one through the workspace flow. It
  // only selects — the Space panel stays in the centre, which is the whole point
  // of the override this build runs with.
  const resolved = await resolveSession(ctx, request);
  if (resolved === null) return 'unavailable';
  // The controller names the Session in the commit that publishes the
  // selection, so read the column on the next frame instead of inside this one.
  await nextFrame();
  try {
    showColumn(ctx, request);
  } catch {
    return 'unavailable';
  }
  if (shouldOpenPage(request)) openPage(ctx, request);
  return 'engaged';
}

/**
 * Expand the column, or toggle it when the caller wants the switch's own
 * behaviour. An already-expanded column stays open for `expandOnly` requests.
 */
function showColumn(ctx: SpaceClientContext, request: RightbarRequest): void {
  if (request.expandOnly === true && ctx.sidebarRight.isExpanded?.() === true) return;
  ctx.sidebarRight.toggleExpanded();
}

/** Whether this request also asks for the page tab. */
function shouldOpenPage(request: RightbarRequest): boolean {
  if (request.openPage === false) return false;
  return request.spaceId !== undefined;
}

/** Open the requested page in the Space page tab. */
function openPage(ctx: SpaceClientContext, request: RightbarRequest): void {
  if (request.spaceId === undefined) return;
  try {
    ctx.sidebarRight.openTab('alter-space.page', {
      params: { spaceId: request.spaceId, nodeId: request.nodeId ?? undefined },
    });
  } catch {
    // A page tab is a bonus on top of the column; its absence is not an
    // activation failure.
  }
}

/**
 * Resolve a Session for the column to draw, without changing the centre.
 *
 * Order: the caller's own Session, then a blank Session of the space's mapped
 * workspace (so the reader's directory context is kept). Both only select; the
 * layout's `startSession`, which would navigate away, is deliberately not used
 * here.
 * @param ctx - client context.
 * @param request - the caller's request, for its optional Session.
 * @returns the Session id now named on screen, or null.
 */
async function resolveSession(
  ctx: SpaceClientContext,
  request: RightbarRequest,
): Promise<DshSessionId | null> {
  const spaceId = request.spaceId;
  if (spaceId === undefined) return null;
  try {
    const workspaceId = await workspaceOfSpace(ctx, spaceId);
    const connect = ctx.uiWorkspace.connectWorkspace;
    if (workspaceId === null || typeof connect !== 'function') return null;
    const sessionId = await connect.call(ctx.uiWorkspace, workspaceId);
    return await waitForSession(ctx, sessionId);
  } catch {
    return null;
  }
}

/** Frames to wait for the column to name the Session (about two seconds). */
const SELECTION_WAIT_FRAMES = 120;

/**
 * Wait until the right column names the Session the workspace flow returned.
 * @param ctx - client context.
 * @param sessionId - the Session that flow selected.
 * @returns the id once the column sees it, else null after the bound.
 */
async function waitForSession(
  ctx: SpaceClientContext,
  sessionId: DshSessionId,
): Promise<DshSessionId | null> {
  const mounted = ctx.sidebarRight.mounted;
  if (mounted === undefined) return null;
  // A frame count rather than a wall clock: the column publishes the name in a
  // commit, and a stalled animation clock must not turn into an early failure.
  for (let frame = 0; frame < SELECTION_WAIT_FRAMES; frame += 1) {
    if (mounted.getSnapshot() === sessionId) return sessionId;
    await nextFrame();
  }
  return null;
}

/** Resolve on the next animation frame (or a macrotask without a DOM clock). */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 16));
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
