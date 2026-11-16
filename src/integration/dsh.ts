/**
 * Structural types for the DSH client services the Space conversation
 * integrations consume.
 *
 * These mirror the shapes the runtime injects; they are deliberately local so
 * the client bundle never imports `@deepseek-ai/*` at runtime (self-contained
 * bundle rule) and typecheck stays dependency-free.
 */

/** Session id as the runtime hands it to us (opaque string). */
export type DshSessionId = string;

/**
 * Minimal `ctx.sessions` face used here.
 *
 * Note: `ISessions` deliberately has no `create` — session creation belongs to
 * the workspace flow (`UiWorkspaceFace.connectWorkspace`), which is what a page
 * conversation uses so the new Session lands in the space's mapped workspace.
 */
export interface SessionsFace {
  /** Host catalog snapshot; used to read back a Session the flow created. */
  readonly list?: {
    getSnapshot(): {
      readonly ids: readonly string[];
      readonly byId: Record<string, { readonly blank?: boolean }>;
    };
    subscribe?(listener: () => void): () => void;
  };
  fork(opts: {
    sessionId: DshSessionId;
    onCreated?: (childId: DshSessionId) => void;
  }): Promise<DshSessionId>;
  /**
   * Create a Session without touching the selection or the centre column.
   *
   * This is the only creator that navigates nowhere: `uiWorkspace.startSession`
   * and `openSession` both show the Conversation, which is wrong when the
   * conversation belongs in the right column.
   */
  create?(opts?: {
    workspaceId?: string;
    cwd?: string;
    agentPreset?: string;
  }): Promise<DshSessionId>;
  archiveSession(
    sessionId: DshSessionId,
    options?: { stopActivity?: boolean },
  ): Promise<void>;
}

/** Minimal `ctx.uiWorkspace` face used here. */
export interface UiWorkspaceFace {
  openSession(target: DshSessionId): void;
  openWorkspace(
    workspaceId: string,
    beforeOpen?: (sessionId: DshSessionId) => void,
  ): Promise<void>;
  /**
   * Resolve the Session a new conversation in a Workspace gets: reuse the
   * first reusable blank member, otherwise create one. Creates without
   * navigating, which is what the right-sidebar entries need.
   */
  connectWorkspace?(
    workspaceId: string,
    options?: { agentPreset?: string },
  ): Promise<DshSessionId>;
  /** Open the Workspace's blank Session (creates one when none is reusable). */
  startSession?(workspaceId?: string, options?: { agentPreset?: string }): void;
}

/** Minimal `ctx.sidebarRight` face used here. */
export interface SidebarRightFace {
  openTab(kind: string, options?: Record<string, unknown>): void;
  openResource(address: string, options?: Record<string, unknown>): void;
  toggleExpanded(): void;
  /** Whether the column is currently expanded; requires a Session on screen. */
  isExpanded?(): boolean;
  /**
   * The Session the right column draws. `undefined` while no Conversation fills
   * the main column (another main panel is active) — the right column has no
   * surface then, and every write throws.
   */
  readonly mounted?: { getSnapshot(): DshSessionId | undefined };
}

/**
 * Minimal `ctx.sidebarRightTabs` face used here: registers one right-sidebar
 * tab type (kind, title, guide entry) and returns its disposer.
 */
export interface SidebarRightTabsFace {
  register(def: Record<string, unknown>): () => void;
}

/** Navigation record the seat keeps for one open right-sidebar tab. */
export interface SidebarTabNavigation {
  address: string;
  /** JSON parameters the opener attached to `sidebarRight.openTab`. */
  params?: unknown;
  /** Bumped by the framework whenever the tab is re-targeted. */
  revision: number;
}

/** `useTabInfo()` result injected into `sidebar.right.pane.tab` bodies. */
export interface SidebarTabInfo {
  sidebar: { expanded: boolean; fullscreen: boolean };
  panel: { id: string; isFloating: boolean };
  tab: {
    id: string;
    kind: string;
    contentId: string;
    title: string;
    navigation: SidebarTabNavigation;
    /** Seat-protocol fields this plugin does not consume yet. */
    signal?: unknown;
    actions?: unknown;
    visible: boolean;
  };
}

/** Hook the seat injects as a prop into tab body components. */
export type UseSidebarTabInfo = () => SidebarTabInfo;

/** Connection RPC caller (same shape `src/client/rpc.ts` builds on). */
export interface ConnectionRpcFace {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } }
  >;
}

/** The DSH client context subset our integrations need. */
export interface SpaceClientContext {
  slots: {
    /** Wait for one cross-plugin seat's declaration, then register into it. */
    inject(key: string, callback: () => () => void): () => void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  sessions: SessionsFace;
  uiWorkspace: UiWorkspaceFace;
  sidebarRight: SidebarRightFace;
  sidebarRightTabs: SidebarRightTabsFace;
  connection: { rpc: ConnectionRpcFace };
  /**
   * Frame layout: the main panel selection. Optional because a host double may
   * not offer it; the creation paths then simply cannot restore the centre.
   */
  layout?: {
    readonly panelInfo?: {
      getSnapshot(): { readonly activePanelId: string | null };
      subscribe?(listener: () => void): () => void;
    };
    selectPanel?(panelId: string | null): void;
  };
}

/** Workspace binding of one space (Host sidecar), via `space.getWorkspaceLink`. */
export async function workspaceOfSpace(
  ctx: SpaceClientContext,
  spaceId: string,
): Promise<string | null> {
  const result = await ctx.connection.rpc.call('/api', 'alter-space', {
    op: 'space.getWorkspaceLink',
    args: [spaceId],
  });
  if (!result.ok) return null;
  const link = result.value as { workspaceId?: string } | null;
  return typeof link?.workspaceId === 'string' ? link.workspaceId : null;
}
