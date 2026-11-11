/**
 * Page-local continuity across a DSH client-module replacement.
 *
 * The DSH Web Host stat-polls every client bundle and replaces a plugin's
 * module in place when its artifact is rebuilt (the build that releases
 * `client.js` is enough). Replacement disposes the plugin fiber first: the
 * layout loses this plugin's `main` entry, `ui-layout` selects the Conversation
 * again and the module's in-memory Space route disappears. Both facts live in
 * the page, not in the module, so keeping them in one page record lets the
 * re-applied module put the reader back on the Space panel and on the document
 * they had open. A real document reload starts a new page context and keeps
 * DSH's default of a fresh layout.
 */

/** Route used before the reader opens anything else in the panel. */
export const DEFAULT_SPACE_PATH = '#/space';

/** How long the page may sit between the interrupted module and its replacement. */
const RESTORE_WINDOW_MS = 10_000;

/** Version of the page record; a shape change starts a fresh record. */
const STATE_VERSION = 1;

/** The record one page keeps across client-module replacements. */
export interface SpaceContinuityState {
  /** Version of this record's shape. */
  readonly version: number;
  /** Whether the Space main panel was selected when the module last ran. */
  active: boolean;
  /** Last in-panel route; the replacing module reopens it. */
  path: string;
  /** When the module owning the active panel began its teardown. */
  interruptedAt?: number;
}

/** Page global that survives a module replacement but not a document reload. */
interface ContinuityPage {
  __ALTER_SPACE_CONTINUITY__?: SpaceContinuityState;
}

/** Panel-state face of the layout service, structurally typed. */
export interface PanelInfoSource {
  getSnapshot(): { readonly activePanelId: string | null };
  subscribe(listener: () => void): () => void;
}

/** Layout service face used by the continuity bridge. */
export interface PanelLayoutLike {
  readonly panelInfo: PanelInfoSource;
  selectPanel(panelId: string | null): void;
}

/** Slot-registry face used to tell a live panel entry from a torn-down one. */
export interface MainSlotEntries {
  entries(name: string): ReadonlyArray<{
    readonly options: { readonly key?: string };
  }>;
}

/** Continuity bridge owned by one module instance. */
export interface ReloadContinuity {
  /**
   * Put the reader back on the panel the interrupted module owned.
   * @returns whether the panel selection was restored.
   */
  restore(): boolean;
  /** Stop tracking; the page record stays for the module that replaces this one. */
  dispose(): void;
}

/**
 * Read the page record, creating it on the page's first load.
 * @returns the page's continuity record, shared by every module instance.
 */
export function spaceContinuity(): SpaceContinuityState {
  const scope = globalThis as unknown as ContinuityPage;
  const existing = scope.__ALTER_SPACE_CONTINUITY__;
  if (existing !== undefined && existing.version === STATE_VERSION)
    return existing;
  const created: SpaceContinuityState = {
    version: STATE_VERSION,
    active: false,
    path: DEFAULT_SPACE_PATH,
  };
  scope.__ALTER_SPACE_CONTINUITY__ = created;
  return created;
}

/**
 * Bridge one module instance to the page record.
 *
 * The panel keeps the reader's place only while they left the module on it:
 * choosing the Conversation (or another panel) ends the record, and the
 * layout's own teardown reset is ignored because by then this plugin's entry
 * is already gone.
 * @param layout - layout service; live for as long as this module runs.
 * @param slots - slot registry, used to distinguish a live panel entry.
 * @param panelId - the main-panel key this plugin registers.
 * @returns the bridge owned by this module instance.
 */
export function createReloadContinuity(
  layout: PanelLayoutLike,
  slots: MainSlotEntries,
  panelId: string,
): ReloadContinuity {
  const state = spaceContinuity();
  const hasPanel = (): boolean =>
    slots.entries('main').some((entry) => entry.options.key === panelId);
  const stop = layout.panelInfo.subscribe(() => {
    const activePanelId = layout.panelInfo.getSnapshot().activePanelId;
    if (activePanelId === panelId) {
      state.active = true;
      state.interruptedAt = undefined;
      return;
    }
    if (activePanelId !== null) {
      state.active = false;
      state.interruptedAt = undefined;
      return;
    }
    // A null selection is the Conversation. Only the reader choosing it ends
    // the record; while this plugin's entry is missing the layout is resetting
    // itself for a replacement and the reader's place must survive.
    if (!hasPanel()) return;
    state.active = false;
    state.interruptedAt = undefined;
  });
  return {
    restore() {
      if (!state.active) return false;
      if (layout.panelInfo.getSnapshot().activePanelId !== null) return false;
      if (!hasPanel()) return false;
      if (state.interruptedAt === undefined) return false;
      if (Date.now() - state.interruptedAt > RESTORE_WINDOW_MS) {
        state.active = false;
        return false;
      }
      layout.selectPanel(panelId);
      state.interruptedAt = undefined;
      return true;
    },
    dispose() {
      if (state.active) state.interruptedAt = Date.now();
      stop();
    },
  };
}
