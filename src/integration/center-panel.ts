/**
 * Keep the centre column where the reader left it.
 *
 * Creating a conversation goes through DSH's workspace flow, and that flow is
 * allowed to navigate: `connectWorkspace` "names the first reusable blank member"
 * and the controller may show it. A conversation created *for the right column*
 * must not swap the Space panel out of the centre, so the creation sites hold the
 * current main panel across the call and put it back if the flow changed it.
 *
 * Restoring is deliberately best-effort: a host without `layout`, a panel that
 * was unregistered meanwhile, or a selection the reader made in between all end
 * the same way — nothing to do, and never a thrown error in a creation path.
 */

/** Minimal layout face this helper needs. */
export interface CenterPanelFace {
  readonly panelInfo?: {
    getSnapshot(): { readonly activePanelId: string | null };
    subscribe?(listener: () => void): () => void;
  };
  selectPanel?(panelId: string | null): void;
}

/** The client context as this helper reads it. */
export interface CenterPanelContext {
  readonly layout?: CenterPanelFace;
}

/** One hold over the centre column. */
export interface CenterPanelHold {
  /** The panel that was active when the hold started (`null` = the Conversation). */
  readonly panelId: string | null;
  /**
   * Put the panel back if the workspace flow replaced it.
   * @returns whether the panel was restored.
   */
  restore(): boolean;
}

/**
 * Hold the current main panel across a creation call.
 * @param ctx - client context carrying `layout`.
 * @returns the hold; `restore()` is safe to call more than once.
 */
export function holdCenterPanel(ctx: CenterPanelContext): CenterPanelHold {
  const panelId = readActivePanel(ctx);
  let restored = false;
  return {
    panelId,
    restore(): boolean {
      if (restored) return false;
      if (panelId === null) return false;
      // The Conversation (`null`) is the flow's own destination; only a plugin
      // panel needs putting back.
      if (readActivePanel(ctx) === panelId) {
        restored = true;
        return false;
      }
      try {
        ctx.layout?.selectPanel?.(panelId);
      } catch {
        return false;
      }
      restored = true;
      return true;
    },
  };
}

/** Read the active main panel, tolerating a host without the layout service. */
function readActivePanel(ctx: CenterPanelContext): string | null {
  try {
    return ctx.layout?.panelInfo?.getSnapshot().activePanelId ?? null;
  } catch {
    return null;
  }
}
