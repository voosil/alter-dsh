/**
 * Route plumbing for the right-sidebar Space page tab.
 *
 * Every tab instance gets a private in-memory router (the same `SpaceRouter`
 * contract the main panel uses) so a tab keeps its own route across tab
 * switches; the host URL is never touched. Route targets are derived from the
 * JSON params the opener attached to `ctx.sidebarRight.openTab(kind, { params })`:
 * `{ spaceId, nodeId }` opens that document, a bare `{ spaceId }` the space
 * overview, no target falls back to the app default `#/space`. A re-open that
 * bumps `navigation.revision` re-targets the private router; identical paths
 * skip, so a re-open of the page already on screen is a no-op.
 */
import type { SpaceRouter } from '@alter/ui-space';
import { docPath, spacePath } from '@alter/ui-space/space-route';

/** Tab-open parameters this plugin understands (JSON via `openTab`). */
export interface SpacePageTabParams {
  spaceId?: string;
  nodeId?: string;
}

/** App default route when the params carry no page target. */
export const DEFAULT_SPACE_PAGE_PATH = '#/space';

/** Coerce the seat's JSON params into the shape this tab understands. */
export function parseSpacePageParams(value: unknown): SpacePageTabParams {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  return {
    spaceId: nonEmptyString(raw.spaceId),
    nodeId: nonEmptyString(raw.nodeId),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Route the params point at; null when they carry no space target. */
export function spacePageTabTarget(params: SpacePageTabParams): string | null {
  if (params.spaceId === undefined) return null;
  return params.nodeId === undefined
    ? spacePath(params.spaceId)
    : docPath(params.spaceId, params.nodeId);
}

/** Initial in-memory route of a freshly opened tab. */
export function initialSpacePageTabPath(params: SpacePageTabParams): string {
  return spacePageTabTarget(params) ?? DEFAULT_SPACE_PAGE_PATH;
}

/** The seat's navigation record, reduced to what the decision needs. */
export interface TabNavigationInput {
  params?: unknown;
  revision?: number;
}

/** What to do about one navigation change. */
export interface TabNavigationDecision {
  /** Revision consumed by this decision; null until a revision was seen. */
  revision: number | null;
  /** Route to navigate to, or null to leave the tab where it is. */
  path: string | null;
}

/**
 * Decide the navigation for a (possibly changed) tab navigation record.
 * Same revision → stay put; a new revision navigates when its params carry a
 * target, otherwise the tab keeps the route the user navigated to. A missing
 * navigation record is "no change".
 */
export function decideTabNavigation(
  previous: TabNavigationDecision,
  next: TabNavigationInput | null | undefined,
): TabNavigationDecision {
  const revision =
    typeof next?.revision === 'number' ? next.revision : undefined;
  if (revision === undefined || revision === previous.revision) {
    return { revision: previous.revision, path: null };
  }
  return {
    revision,
    path: spacePageTabTarget(parseSpacePageParams(next?.params)),
  };
}

/**
 * Private in-memory router for one tab instance (the `SpaceRouter` contract
 * `SpaceApp` consumes). The `replace` option callers may pass has no separate
 * meaning here: there is no history stack to replace.
 */
export function createSpacePageTabRouter(initialPath: string): SpaceRouter {
  let path = initialPath;
  const listeners = new Set<() => void>();
  return {
    getPath: () => path,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate(next: string) {
      if (next === path) return;
      path = next;
      for (const listener of listeners) listener();
    },
  };
}
