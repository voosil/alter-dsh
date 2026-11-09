/**
 * Client-side block diff → Host Document Operations.
 *
 * The editor owns a Tiptap document; the Host only accepts the v0 Operation
 * channel (`docs/specs/document-operations-v0.md`). `computeOperations` turns a
 * pair of `AlterDoc`s into a minimal-by-construction operation batch such that
 * `applyOperations(oldDoc, ops)` is structurally equal to `newDoc`.
 *
 * Algorithm (why this shape):
 * 1. Compare the **top-level** block subtrees. A subtree that is identical
 *    keeps its identity and position.
 * 2. A changed top-level subtree is regenerated: it is deleted in the first
 *    phase and re-inserted at its new position in the second phase. Deleting
 *    the old subtree frees all descendant ids for the same batch (the Host
 *    re-computes used ids after every operation), so the re-insert keeps every
 *    block id from `newDoc` — including ids that moved in or out of the
 *    subtree. `replace_block` cannot be used for containers here: the Host
 *    forces the target id but re-issues *all colliding descendant ids*
 *    (`prepareReplacementBlock` + `assignBlockIds`), which would silently
 *    rewrite child ids on a nested edit.
 * 3. Childless leaf changes (text edits, atoms, callouts emptied to `block*`)
 *    use `replace_block`: the target id is preserved and there are no
 *    descendants to re-issue. Attribute-only changes on containers use
 *    `update_attrs`, which leaves children untouched.
 * 4. Removed top-level roots are deleted in the first phase; filler paragraphs
 *    for empty containers disappear with their regenerated parent.
 * 5. The second phase rebuilds the top-level order with `move_block` for
 *    surviving blocks and `insert_blocks` for added/regenerated runs (one
 *    insertion per consecutive run), so the resulting order matches `newDoc`.
 *
 * Every generated batch is bounded by the Host limit (64 operations). Larger
 * edits throw {@link DocumentDiffError} with a readable Chinese message
 * ("变更过大") so the editor can ask the user to split the change instead of
 * surfacing a raw Host failure.
 *
 * @module @alter-dsh/space/document/editor/operations
 */
import type { AlterDoc, BlockNode, JsonValue, Operation } from '../types';
import {
  blocksEqual,
  deepEqualJson,
  inlineKey,
} from './canonical';

/** Host limit for one operation batch (`validateOperationsShape`). */
export const MAX_DIFF_OPERATIONS = 64;

/** Raised when one edit would need more operations than the Host accepts. */
export class DocumentDiffError extends Error {
  readonly code = 'doc-edit/too-large';

  constructor(message: string) {
    super(message);
    this.name = 'DocumentDiffError';
  }
}

type BlockAction = 'keep' | 'replace' | 'update_attrs' | 'reinsert';

/**
 * Compute the operation batch that turns `oldDoc` into `newDoc`.
 *
 * `revision`/`schemaVersion` are intentionally ignored: the Host owns revision
 * bumps and schema validation. Returns `[]` when the block trees are identical.
 *
 * @param oldDoc - document currently stored on the Host (base revision).
 * @param newDoc - document produced from the editor.
 * @param limit - maximum batch length (defaults to the Host's 64).
 */
export function computeOperations(
  oldDoc: AlterDoc,
  newDoc: AlterDoc,
  limit: number = MAX_DIFF_OPERATIONS,
): Operation[] {
  const ops = diffBlocks(oldDoc.blocks, newDoc.blocks);
  if (ops.length > limit) {
    throw new DocumentDiffError(
      `变更过大：需要 ${ops.length} 个操作，超过单次上限 ${limit}。请分批保存后再试。`,
    );
  }
  return ops;
}

/** Diff two top-level block lists into an ordered operation batch. */
function diffBlocks(
  oldBlocks: readonly BlockNode[],
  newBlocks: readonly BlockNode[],
): Operation[] {
  const oldTopLevel = new Map<string, BlockNode>();
  for (const block of oldBlocks) {
    // Duplicate top-level ids are invalid output of the mapping; keep the first.
    if (!oldTopLevel.has(block.id)) oldTopLevel.set(block.id, block);
  }

  /** Operations that must run before any insertion (they free block ids). */
  const freePhase: Operation[] = [];
  /** Ids of new top-level blocks that still exist after the free phase. */
  const survivingIds = new Set<string>();

  for (const newBlock of newBlocks) {
    const oldBlock = oldTopLevel.get(newBlock.id);
    if (oldBlock === undefined) continue;
    oldTopLevel.delete(newBlock.id);
    const action = classify(oldBlock, newBlock);
    switch (action) {
      case 'keep':
        survivingIds.add(newBlock.id);
        break;
      case 'replace':
        freePhase.push({
          op: 'replace_block',
          target: newBlock.id,
          blocks: [newBlock],
        });
        survivingIds.add(newBlock.id);
        break;
      case 'update_attrs': {
        const attrs = attrsPatch(oldBlock.attrs, newBlock.attrs);
        if (Object.keys(attrs).length > 0) {
          freePhase.push({ op: 'update_attrs', target: newBlock.id, attrs });
        }
        survivingIds.add(newBlock.id);
        break;
      }
      case 'reinsert':
        freePhase.push({ op: 'delete_block', target: newBlock.id });
        break;
    }
  }
  // Removed top-level roots: deleting them frees their subtree ids, which the
  // insertion phase may reuse for blocks that moved into another subtree.
  for (const block of oldTopLevel.values()) {
    freePhase.push({ op: 'delete_block', target: block.id });
  }

  const orderPhase = orderTopLevel(oldBlocks, newBlocks, survivingIds);
  return [...freePhase, ...orderPhase];
}

/**
 * Rebuild the top-level order: `move_block` surviving blocks into place and
 * insert added/regenerated blocks in consecutive runs.
 */
function orderTopLevel(
  oldBlocks: readonly BlockNode[],
  newBlocks: readonly BlockNode[],
  survivingIds: ReadonlySet<string>,
): Operation[] {
  const currentIds = oldBlocks
    .map((block) => block.id)
    .filter((id) => survivingIds.has(id));
  const ops: Operation[] = [];

  for (let index = 0; index < newBlocks.length; ) {
    const target = newBlocks[index]!;
    if (survivingIds.has(target.id)) {
      if (currentIds[index] !== target.id) {
        const from = currentIds.indexOf(target.id);
        if (from < 0) {
          throw new DocumentDiffError(
            `内部错误：块 ${target.id} 不在当前文档中，无法重建顺序`,
          );
        }
        if (from > index) {
          currentIds.splice(from, 1);
          currentIds.splice(index, 0, target.id);
          ops.push({ op: 'move_block', target: target.id, index });
        }
      }
      index += 1;
      continue;
    }
    // Group a run of newly inserted / regenerated siblings into one operation.
    const blocks: BlockNode[] = [];
    let end = index;
    while (end < newBlocks.length && !survivingIds.has(newBlocks[end]!.id)) {
      blocks.push(newBlocks[end]!);
      end += 1;
    }
    ops.push({ op: 'insert_blocks', index, blocks });
    currentIds.splice(index, 0, ...blocks.map((block) => block.id));
    index = end;
  }
  return ops;
}

/** Decide what one changed top-level block needs. */
function classify(oldBlock: BlockNode, newBlock: BlockNode): BlockAction {
  if (blocksEqual(oldBlock, newBlock)) return 'keep';
  if (oldBlock.type !== newBlock.type) return 'reinsert';
  const hasChildren =
    newBlock.children !== undefined && newBlock.children.length > 0;
  if (!hasChildren) {
    // `replace_block` keeps the target id and has no descendants to re-issue.
    // `tableRow` is the only v0 type that forbids the operation.
    return newBlock.type === 'tableRow' ? 'reinsert' : 'replace';
  }
  const childrenEqual = blocksOfChildrenEqual(
    oldBlock.children,
    newBlock.children,
  );
  if (childrenEqual && inlineKey(oldBlock.content) === inlineKey(newBlock.content)) {
    return newBlock.type === 'tableRow' ? 'reinsert' : 'update_attrs';
  }
  return 'reinsert';
}

function blocksOfChildrenEqual(
  left: BlockNode[] | undefined,
  right: BlockNode[] | undefined,
): boolean {
  const leftChildren = left ?? [];
  const rightChildren = right ?? [];
  if (leftChildren.length !== rightChildren.length) return false;
  return leftChildren.every((child, index) =>
    blocksEqual(child, rightChildren[index]!),
  );
}

/**
 * Patch from `oldAttrs` to `newAttrs`; removed attributes become `null`
 * (the Host deletes them, optional attributes only).
 */
function attrsPatch(
  oldAttrs: BlockNode['attrs'],
  newAttrs: BlockNode['attrs'],
): Record<string, JsonValue | null> {
  const patch: Record<string, JsonValue | null> = {};
  const keys = new Set([
    ...Object.keys(oldAttrs ?? {}),
    ...Object.keys(newAttrs ?? {}),
  ]);
  for (const key of keys) {
    const oldValue = oldAttrs?.[key] ?? null;
    const newValue = newAttrs?.[key] ?? null;
    if (deepEqualJson(oldValue, newValue)) continue;
    patch[key] = newValue;
  }
  return patch;
}
