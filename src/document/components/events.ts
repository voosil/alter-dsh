/**
 * Window events exchanged between component node views and the editor surface.
 *
 * Node views are rendered by Tiptap outside the editor component tree, so the
 * preview asks the surface (which owns the RPC client and dialogs) to open the
 * props editor through a `CustomEvent` — the same pattern as mindmap editing.
 *
 * @module @alter-dsh/space/document/components/events
 */
import type { ComponentPayload } from '@alter/protocol';

/** Window event dispatched by a component node view to request props editing. */
export const COMPONENT_EDIT_EVENT = 'alter-component-edit';

/** Detail of {@link COMPONENT_EDIT_EVENT}. */
export interface ComponentEditRequest {
  /** Object id stored in the block attrs. */
  objectId: string;
  /** AST block id of the `component` block (missing for unsaved draft blocks). */
  blockId?: string;
  /** Payload already loaded by the preview, so the dialog opens immediately. */
  payload?: ComponentPayload;
}
