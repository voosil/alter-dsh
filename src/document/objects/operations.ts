/**
 * Document-Operations builders for structured-object blocks (mindmap /
 * component).
 *
 * A Host `update_object` target must already exist in the document the batch is
 * applied against: the Host resolves operation targets against the batch's
 * base document and its object factory re-reads the stored document, so a
 * block inserted earlier in the *same* batch cannot be targeted yet. New
 * object blocks are therefore created in two batches:
 *
 * 1. `insert_blocks` with a placeholder object ref (`obj_pending`);
 * 2. `update_object` on the now-existing block id, which creates the real
 *    `obj_…` and rewrites the block attr.
 *
 * The helpers here keep the two batches and the cleanup path consistent; P4
 * components reuse the same pattern.
 *
 * @module @alter-dsh/space/document/objects/operations
 */
import type { JsonValue, Operation } from '../types';

/** Block kinds backed by an object side-table record. */
export type PendingObjectBlockKind = 'mindmap' | 'component';

/**
 * Placeholder object ref of a block whose real object does not exist yet.
 * The Host only requires `obj_…` shape, so the block validates before the
 * `update_object` batch replaces it.
 */
export const PENDING_OBJECT_ID = 'obj_pending';

/** Input of {@link buildPendingObjectInsertOperation}. */
export interface PendingObjectInsertInput {
  /** Client-generated block id; the Host preserves it when it is unique. */
  blockId: string;
  kind: PendingObjectBlockKind;
  /** Insert after this sibling block id; omitted inserts at the parent end. */
  after?: string;
}

/** Batch 1: insert an object block carrying the placeholder object ref. */
export function buildPendingObjectInsertOperation(
  input: PendingObjectInsertInput,
): Operation {
  return {
    op: 'insert_blocks',
    ...(input.after === undefined ? {} : { after: input.after }),
    blocks: [
      {
        id: input.blockId,
        type: input.kind,
        attrs: { objectId: PENDING_OBJECT_ID },
      },
    ],
  };
}

/** Batch 2: create the real object and replace the block's object ref. */
export function buildUpdateObjectOperation(
  blockId: string,
  payload: JsonValue,
): Operation {
  return { op: 'update_object', target: blockId, payload };
}

/** Cleanup: delete the placeholder block after a failed batch 2. */
export function buildDeleteBlockOperation(blockId: string): Operation {
  return { op: 'delete_block', target: blockId };
}
