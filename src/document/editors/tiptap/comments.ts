/**
 * Comment decorations for the AST-native kernel.
 *
 * The frozen editor underlines commented text with the CSS Custom Highlight API
 * (`::highlight(alter-comment)`), which paints a range without touching the
 * DOM. ProseMirror owns its DOM, so the kernel uses decorations instead — a
 * structurally equivalent choice that keeps the same visual contract:
 *
 * - the comment range gets the underline the stylesheet defines for
 *   `::highlight(alter-comment)`, applied through the same class the kernel
 *   exposes (`alter-comment` / `alter-comment-active`);
 * - the active comment additionally gets the soft background.
 *
 * Anchors are resolved from the comment's `quote` text, the same fallback the
 * legacy editor uses when it has no stored offset: the first unique match wins,
 * and an ambiguous or missing quote paints nothing rather than guessing.
 *
 * @module @alter-dsh/space/document/editors/tiptap/comments
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorKernelComment } from '../kernel';

/** Plugin key holding the current decoration set. */
export const commentPluginKey = new PluginKey<DecorationSet>('alterSpaceComments');

/** Class names the frozen stylesheet styles. */
export const COMMENT_CLASS = 'alter-comment';
export const COMMENT_ACTIVE_CLASS = 'alter-comment-active';

/** One resolved comment range in ProseMirror positions. */
export interface ResolvedCommentRange {
  id: string;
  from: number;
  to: number;
  active: boolean;
}

/**
 * Flat text of a ProseMirror document plus a position map.
 *
 * Inline positions advance by one per character; block boundaries insert a
 * newline placeholder so a quote never spans two blocks by accident (matching
 * the legacy editor, which matched quotes inside one block's text).
 */
export function documentTextIndex(doc: PmNode): {
  text: string;
  positions: number[];
} {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? '';
      for (let index = 0; index < value.length; index += 1) {
        positions.push(pos + index);
        text += value[index];
      }
      return false;
    }
    if (node.isBlock && text !== '' && !text.endsWith('\n')) {
      text += '\n';
      positions.push(pos);
    }
    return true;
  });
  return { text, positions };
}

/** Find every occurrence of `quote` in `text`. */
function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  if (quote === '') return found;
  let from = text.indexOf(quote);
  while (from >= 0) {
    found.push(from);
    from = text.indexOf(quote, from + 1);
  }
  return found;
}

/**
 * Resolve comment quotes to document ranges.
 *
 * Only unique quotes resolve: an ambiguous quote would otherwise highlight the
 * wrong paragraph, which is worse than no highlight (`planReanchor` makes the
 * same trade-off for stored anchors).
 */
export function resolveCommentRanges(
  doc: PmNode,
  comments: readonly EditorKernelComment[],
  activeCommentId: string | null | undefined,
): ResolvedCommentRange[] {
  const { text, positions } = documentTextIndex(doc);
  const ranges: ResolvedCommentRange[] = [];
  for (const comment of comments) {
    const quote = comment.quote.trim();
    if (quote === '') continue;
    const found = occurrences(text, quote);
    if (found.length !== 1) continue;
    const start = found[0]!;
    const end = start + quote.length;
    const from = positions[start];
    const to = positions[end - 1];
    if (from === undefined || to === undefined) continue;
    ranges.push({
      id: comment.id,
      from,
      to: to + 1,
      active: comment.id === activeCommentId,
    });
  }
  return ranges;
}

/** Build the decoration set for one document + comment list. */
export function commentDecorations(
  doc: PmNode,
  comments: readonly EditorKernelComment[],
  activeCommentId: string | null | undefined,
): DecorationSet {
  const ranges = resolveCommentRanges(doc, comments, activeCommentId);
  if (ranges.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    ranges.map((range) =>
      Decoration.inline(
        range.from,
        range.to,
        {
          class: range.active
            ? `${COMMENT_CLASS} ${COMMENT_ACTIVE_CLASS}`
            : COMMENT_CLASS,
          'data-comment-id': range.id,
        },
        { commentId: range.id },
      ),
    ),
  );
}

/** Push a new comment list into a live editor view (decorations only). */
export function updateCommentExtensionOptions(
  view: EditorView,
  comments: readonly EditorKernelComment[],
  activeCommentId: string | null | undefined,
): void {
  view.dispatch(
    view.state.tr.setMeta(commentPluginKey, {
      comments,
      activeCommentId: activeCommentId ?? null,
    }),
  );
}

/** Options the kernel passes to the comment extension. */
export interface CommentExtensionOptions {
  /** Comments to underline; read on every rebuild so edits stay current. */
  comments: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  /** Click on a commented range (opens the rail, as the frozen page does). */
  onCommentedTextClick?: () => void;
}

/**
 * The comment-decoration extension.
 *
 * Decorations are derived state: they are rebuilt whenever the document changes
 * and whenever the extension's options are updated
 * ({@link updateCommentExtensionOptions}), so a new/deleted/resolved comment or
 * a changed active id never leaves a stale underline behind.
 */
export function createCommentExtension(options: CommentExtensionOptions): Extension {
  return Extension.create({
    name: 'alterSpaceComments',
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: commentPluginKey,
          state: {
            init: (_, state) =>
              commentDecorations(
                state.doc,
                options.comments,
                options.activeCommentId,
              ),
            apply(transaction, previous) {
              // An explicit refresh (comment list / active id changed) always
              // wins; the document did not change, so positions are reused.
              const refresh = transaction.getMeta(commentPluginKey) as
                | {
                    comments: readonly EditorKernelComment[];
                    activeCommentId?: string | null;
                  }
                | undefined;
              if (refresh !== undefined) {
                return commentDecorations(
                  transaction.doc,
                  refresh.comments,
                  refresh.activeCommentId ?? null,
                );
              }
              if (!transaction.docChanged) return previous;
              // A document edit invalidates offsets; rebuild from the current
              // options so a comment added since mount is honoured too.
              return commentDecorations(
                transaction.doc,
                options.comments,
                options.activeCommentId,
              );
            },
          },
          props: {
            decorations(state) {
              return commentPluginKey.getState(state) ?? DecorationSet.empty;
            },
            handleClick(view, pos) {
              const set = commentPluginKey.getState(view.state);
              if (set === undefined) return false;
              // `find` only returns decorations that cover `pos`; a commented
              // range is the only inline decoration this plugin creates.
              const hit = set
                .find(pos, pos)
                .some((decoration) => decoration.spec?.['commentId'] !== undefined);
              if (hit) options.onCommentedTextClick?.();
              return false;
            },
          },
        }),
      ];
    },
  });
}

