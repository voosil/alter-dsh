/**
 * Stable block ids for editor-created blocks.
 *
 * An AST block's `id` is its identity across saves: comment anchors address
 * blocks by id and the save controller diffs by id. ProseMirror nodes created
 * while typing (`splitBlock`, list Enter, a slash-command insert) start with
 * `id: null`; if the id were only assigned during `capture()`, every save of the
 * same document would produce *new* ids — the Host would see delete+insert
 * churn, comment anchors would drift, and the crash draft would not match.
 *
 * This plugin assigns an id the first time a block appears in the document (at
 * the end of the transaction that created it), so a block keeps its identity
 * for as long as the editor lives.
 *
 * @module @alter-dsh/space/document/editors/tiptap/block-ids
 */
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { allocateBlockId } from './convert';

/** The block-id extension (one plugin, no commands). */
export function createBlockIdExtension(): Extension {
  return Extension.create({
    name: 'alterSpaceBlockIds',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          /**
           * Only runs after a document change, and only when some block still
           * lacks an id: assigning none returns `null`, so the plugin cannot
           * loop on its own transaction.
           */
          appendTransaction(transactions, _oldState, state) {
            if (!transactions.some((transaction) => transaction.docChanged)) {
              return null;
            }
            const transaction = state.tr;
            let assigned = 0;
            state.doc.descendants((node, pos) => {
              if (!node.isBlock) return true;
              const spec = node.type.spec.attrs;
              if (spec === undefined || spec['id'] === undefined) return true;
              const id = node.attrs['id'];
              if (typeof id === 'string' && id !== '') return true;
              transaction.setNodeAttribute(pos, 'id', allocateBlockId());
              assigned += 1;
              return true;
            });
            // Assigning ids is bookkeeping, not a user edit: keep it out of the
            // undo stack so Ctrl+Z steps through actual edits only.
            if (assigned > 0) transaction.setMeta('addToHistory', false);
            return assigned === 0 ? null : transaction;
          },
        }),
      ];
    },
  });
}