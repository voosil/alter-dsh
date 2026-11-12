/**
 * Comment ranges for the AST-native kernel: painting, caret tracking and quote
 * maintenance.
 *
 * The frozen editor paints commented ranges with the **CSS Custom Highlight
 * API** (`CSS.highlights.set('alter-comment', …)`), never by wrapping DOM: the
 * stylesheet only defines `::highlight(alter-comment)` /
 * `::highlight(alter-comment-active)` plus one DOM fallback for inline doc-link
 * icons (`[data-doc-icon][data-comment-mark]`). A kernel that adds a class
 * instead paints nothing.
 *
 * Comment anchors are flat-text offsets, exactly like the frozen editor:
 *
 * 1. on load a comment's `quote` is matched once in the body text (unique match
 *    only — an ambiguous quote paints nothing rather than guessing);
 * 2. every edit shifts the anchors through a single-prefix/suffix text diff;
 * 3. when the text under an anchor changes, the new snippet becomes the
 *    comment's quote, and the page (which owns persistence) is told to save it.
 *
 * Doc-link icons that overlap a commented range get the same
 * `data-comment-mark` attribute the frozen editor adds, so the underline stays
 * continuous across the inline SVG.
 *
 * @module @alter-dsh/space/document/editors/tiptap/comments
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorKernelComment } from '../kernel';

/** Highlight names the frozen stylesheet styles. */
export const COMMENT_HIGHLIGHT = 'alter-comment';
export const COMMENT_ACTIVE_HIGHLIGHT = 'alter-comment-active';

/** Attribute the frozen stylesheet uses for the doc-link icon fallback. */
export const COMMENT_MARK_ATTRIBUTE = 'data-comment-mark';

/** One flat-text comment range. */
export interface CommentAnchor {
  start: number;
  end: number;
  /** Snippet the anchor covered when it was last validated. */
  quote: string;
}

/** One comment whose quote changed under the caret, ready to be persisted. */
export interface CommentQuoteUpdate {
  id: string;
  quote: string;
}

/** One resolved comment range in ProseMirror positions. */
export interface ResolvedCommentRange {
  id: string;
  from: number;
  to: number;
  active: boolean;
}

/** Flat body text plus the ProseMirror position of every character. */
export interface DocumentTextIndex {
  text: string;
  positions: number[];
}

/**
 * Flat text of a ProseMirror document plus a position map.
 *
 * Inline positions advance by one per character; block boundaries insert a
 * newline placeholder so a quote never spans two blocks by accident (matching
 * the frozen editor, which matched quotes inside one block's text).
 */
export function documentTextIndex(doc: PmNode): DocumentTextIndex {
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

/** One contiguous text edit (prefix/suffix diff of two strings). */
export interface TextEdit {
  start: number;
  removed: number;
  inserted: number;
}

/** The single contiguous edit between two versions of the body text. */
export function textEditBetween(previous: string, next: string): TextEdit | null {
  if (previous === next) return null;
  let prefix = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(previous.length, next.length) - prefix;
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    removed: previous.length - prefix - suffix,
    inserted: next.length - prefix - suffix,
  };
}

/** Shift one anchor boundary through an edit. */
function moveBoundary(
  position: number,
  edit: TextEdit,
  isEnd: boolean,
): number {
  const editEnd = edit.start + edit.removed;
  if (position <= edit.start) return position;
  if (position >= editEnd) return position + edit.inserted - edit.removed;
  return isEnd ? edit.start + edit.inserted : edit.start;
}

/** Shift one anchor through an edit (same rule as the frozen editor). */
export function transformAnchor(anchor: CommentAnchor, edit: TextEdit): CommentAnchor {
  const start = Math.max(0, moveBoundary(anchor.start, edit, false));
  const end = Math.max(start, moveBoundary(anchor.end, edit, true));
  return { start, end, quote: anchor.quote };
}

/** Whether an anchor still covers exactly its quote. */
function anchorMatches(anchor: CommentAnchor, text: string): boolean {
  return anchor.end <= text.length && text.slice(anchor.start, anchor.end) === anchor.quote;
}

/**
 * Seed one anchor per comment from the body text.
 *
 * A previous anchor that still matches its quote is kept (it survived edits);
 * otherwise the quote is matched again — unique matches only.
 */
export function seedAnchors(
  comments: readonly EditorKernelComment[],
  text: string,
  previous?: ReadonlyMap<string, CommentAnchor>,
): Map<string, CommentAnchor> {
  const anchors = new Map<string, CommentAnchor>();
  for (const comment of comments) {
    const quote = comment.quote;
    if (quote === '') continue;
    const existing = previous?.get(comment.id);
    if (existing !== undefined) {
      const moved = { ...existing, quote };
      if (anchorMatches(moved, text)) {
        anchors.set(comment.id, moved);
        continue;
      }
      // Keep the shifted range even when its text changed (the user edited
      // inside the comment); the quote is updated from it below.
      if (moved.end > moved.start && moved.end <= text.length) {
        anchors.set(comment.id, { ...moved, quote: text.slice(moved.start, moved.end) });
        continue;
      }
    }
    const found = occurrences(text, quote);
    if (found.length === 1) {
      anchors.set(comment.id, {
        start: found[0]!,
        end: found[0]! + quote.length,
        quote,
      });
    }
  }
  return anchors;
}

/** Resolve the anchors to ProseMirror ranges for painting. */
export function rangeOfAnchor(
  index: DocumentTextIndex,
  anchor: CommentAnchor,
): { from: number; to: number } | null {
  if (anchor.end <= anchor.start) return null;
  const from = index.positions[anchor.start];
  const to = index.positions[anchor.end - 1];
  if (from === undefined || to === undefined) return null;
  return { from, to: to + 1 };
}

/**
 * Resolve comment quotes to ProseMirror ranges.
 *
 * Kept as the pure entry point for tests and one-off checks (the live editor
 * paints from its maintained anchors instead).
 */
export function resolveCommentRanges(
  doc: PmNode,
  comments: readonly EditorKernelComment[],
  activeCommentId: string | null | undefined,
): ResolvedCommentRange[] {
  const index = documentTextIndex(doc);
  const ranges: ResolvedCommentRange[] = [];
  for (const [id, anchor] of seedAnchors(comments, index.text)) {
    const range = rangeOfAnchor(index, anchor);
    if (range === null) continue;
    ranges.push({ id, from: range.from, to: range.to, active: id === activeCommentId });
  }
  return ranges;
}

/** Paint state derived for one editor state. */
export interface CommentPaintState {
  comments: readonly EditorKernelComment[];
  activeCommentId: string | null;
  text: string;
  anchors: Map<string, CommentAnchor>;
  /** Quotes that changed through editing and are not persisted yet. */
  pendingQuotes: CommentQuoteUpdate[];
}

/** Plugin key holding the paint state. */
export const commentPluginKey = new PluginKey<CommentPaintState>('alterSpaceComments');

/** Build the paint state for one document + comment list. */
export function commentStateFor(
  doc: PmNode,
  comments: readonly EditorKernelComment[],
  activeCommentId: string | null | undefined,
  previous?: CommentPaintState,
): CommentPaintState {
  const index = documentTextIndex(doc);
  let anchors: Map<string, CommentAnchor>;
  let pendingQuotes: CommentQuoteUpdate[] = [];
  if (previous === undefined) {
    anchors = seedAnchors(comments, index.text);
  } else {
    const edit =
      previous.text === index.text
        ? null
        : textEditBetween(previous.text, index.text);
    anchors = new Map();
    for (const [id, anchor] of previous.anchors) {
      anchors.set(id, edit === null ? anchor : transformAnchor(anchor, edit));
    }
    // Comments that were not anchored yet (added while editing) seed now.
    for (const [id, anchor] of seedAnchors(comments, index.text)) {
      if (!anchors.has(id)) anchors.set(id, anchor);
    }
    // Only comments that still exist keep an anchor.
    for (const id of [...anchors.keys()]) {
      if (!comments.some((comment) => comment.id === id)) anchors.delete(id);
    }
    for (const comment of comments) {
      const anchor = anchors.get(comment.id);
      if (anchor === undefined) continue;
      const snippet = index.text.slice(anchor.start, anchor.end);
      if (snippet !== comment.quote) {
        pendingQuotes.push({ id: comment.id, quote: snippet });
        anchors.set(comment.id, { ...anchor, quote: snippet });
      }
    }
  }
  return {
    comments,
    activeCommentId: activeCommentId ?? null,
    text: index.text,
    anchors,
    pendingQuotes,
  };
}

/** The DOM `Highlight` constructor, when the browser provides the API. */
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface HighlightEnvironment {
  registry: HighlightRegistryLike;
  Highlight: new (...ranges: Range[]) => unknown;
}

/**
 * The CSS Custom Highlight API surface, or `undefined` without support.
 *
 * Browsers without the API get the same graceful degradation as the frozen
 * editor: no underline (and no crash).
 */
function highlightEnvironment(): HighlightEnvironment | undefined {
  if (typeof CSS === 'undefined') return undefined;
  const css = CSS as unknown as { highlights?: HighlightRegistryLike };
  const registry = css.highlights;
  const HighlightConstructor = (globalThis as { Highlight?: unknown }).Highlight;
  if (registry === undefined || typeof HighlightConstructor !== 'function') {
    return undefined;
  }
  return {
    registry,
    Highlight: HighlightConstructor as HighlightEnvironment['Highlight'],
  };
}

/** Clear every paint this module owns (idempotent, also used on destroy). */
export function clearCommentPaint(view?: EditorView): void {
  const environment = highlightEnvironment();
  environment?.registry.delete(COMMENT_HIGHLIGHT);
  environment?.registry.delete(COMMENT_ACTIVE_HIGHLIGHT);
  if (view === undefined) return;
  view.dom
    .querySelectorAll<HTMLElement>(`[${COMMENT_MARK_ATTRIBUTE}]`)
    .forEach((element) => element.removeAttribute(COMMENT_MARK_ATTRIBUTE));
}

/** One DOM range, or `null` when the positions cannot be mapped. */
function domRange(view: EditorView, from: number, to: number): Range | null {
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Mark inline doc-link icons that overlap a commented range.
 *
 * The frozen stylesheet carries a DOM fallback for `[data-doc-icon]` because an
 * inline SVG interrupts the `::highlight()` underline; the attribute makes the
 * underline continuous there too.
 */
function paintDocIconMarks(view: EditorView): void {
  view.dom
    .querySelectorAll<HTMLElement>('[data-doc-icon]')
    .forEach((icon) => icon.removeAttribute(COMMENT_MARK_ATTRIBUTE));
  const state = commentPluginKey.getState(view.state);
  if (state === undefined || state.anchors.size === 0) return;
  const index = documentTextIndex(view.state.doc);
  const ranges = [...state.anchors.entries()]
    .map(([id, anchor]) => {
      const range = rangeOfAnchor(index, anchor);
      return range === null ? null : { id, ...range };
    })
    .filter((entry): entry is { id: string; from: number; to: number } => entry !== null);
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'docLink') return true;
    const end = pos + node.nodeSize;
    const hit = ranges.find((range) => range.from < end && range.to > pos);
    if (hit === undefined) return true;
    const element = view.nodeDOM(pos);
    const icon =
      element instanceof HTMLElement
        ? element.querySelector<HTMLElement>('[data-doc-icon]')
        : null;
    icon?.setAttribute(
      COMMENT_MARK_ATTRIBUTE,
      hit.id === state.activeCommentId ? 'active' : 'open',
    );
    return true;
  });
}

/**
 * Paint one comment state onto the live view.
 *
 * Registers the two highlight names the frozen stylesheet defines and refreshes
 * the doc-link icon marks. Safe to call repeatedly: it replaces (never nests)
 * the registered highlights.
 */
export function paintCommentHighlights(
  view: EditorView,
  state: CommentPaintState,
): void {
  const environment = highlightEnvironment();
  if (environment !== undefined) {
    const index = documentTextIndex(view.state.doc);
    const open: Range[] = [];
    const active: Range[] = [];
    for (const [id, anchor] of state.anchors) {
      if (state.comments.every((comment) => comment.id !== id)) continue;
      const range = rangeOfAnchor(index, anchor);
      if (range === null) continue;
      const painted = domRange(view, range.from, range.to);
      if (painted === null) continue;
      (id === state.activeCommentId ? active : open).push(painted);
    }
    // Replace both names every time so a stale highlight cannot survive.
    environment.registry.set(
      COMMENT_HIGHLIGHT,
      new environment.Highlight(...open),
    );
    environment.registry.set(
      COMMENT_ACTIVE_HIGHLIGHT,
      new environment.Highlight(...active),
    );
  }
  paintDocIconMarks(view);
}

/**
 * The comment whose range contains the collapsed caret.
 *
 * The frozen page kept the hovered/caret comment active, so the rail card and
 * the text tint stayed in sync with the cursor; this is the same rule for the
 * AST kernel.
 */
export function caretCommentIdOf(view: EditorView): string | null {
  const state = commentPluginKey.getState(view.state);
  if (state === undefined) return null;
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const index = documentTextIndex(view.state.doc);
  const pos = selection.from;
  for (const [id, anchor] of state.anchors) {
    const range = rangeOfAnchor(index, anchor);
    if (range !== null && pos >= range.from && pos <= range.to) return id;
  }
  return null;
}

/** Options the kernel passes to the comment extension. */
export interface CommentExtensionOptions {
  /** Comments to underline; read on every rebuild so edits stay current. */
  comments: readonly EditorKernelComment[];
  activeCommentId?: string | null;
  /** Click on a commented range (opens the rail, as the frozen page does). */
  onCommentedTextClick?: () => void;
  /** Comment under the caret, or `null` when the caret left every comment. */
  onCommentAtCaretChange?: (commentId: string | null) => void;
  /** Quotes that changed through editing; the page persists them. */
  onCommentQuotesChange?: (updates: CommentQuoteUpdate[]) => void;
}

/**
 * Push a new comment list into a live editor view (repaint only, no edit).
 *
 * The page calls this when the comment list or the active comment changes; it
 * is a transaction meta, so it never enters the undo stack or the saved AST.
 */
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

/**
 * Paint the current comment list onto a live view.
 *
 * The kernel calls this once after mounting (a ProseMirror plugin view is not
 * updated on editor creation) and the extension repaints on every later change.
 */
export function repaintComments(
  view: EditorView,
  comments: readonly EditorKernelComment[],
  activeCommentId: string | null | undefined,
): void {
  paintCommentHighlights(
    view,
    commentStateFor(view.state.doc, comments, activeCommentId),
  );
}

/**
 * The comment extension.
 *
 * Paint state is derived data: it is rebuilt whenever the document changes and
 * whenever the page pushes a new comment list, then re-painted onto the live
 * view. Nothing here touches the document (highlights are view-only); quote
 * changes are reported to the page, which owns persistence.
 */
export function createCommentExtension(options: CommentExtensionOptions): Extension {
  return Extension.create({
    name: 'alterSpaceComments',
    addProseMirrorPlugins() {
      return [
        new Plugin<CommentPaintState>({
          key: commentPluginKey,
          state: {
            init: (_, state) =>
              commentStateFor(state.doc, options.comments, options.activeCommentId),
            apply(transaction, previous) {
              const refresh = transaction.getMeta(commentPluginKey) as
                | {
                    comments?: readonly EditorKernelComment[];
                    activeCommentId?: string | null;
                  }
                | undefined;
              if (refresh !== undefined) {
                const comments = refresh.comments ?? previous.comments;
                return commentStateFor(
                  transaction.doc,
                  comments,
                  refresh.activeCommentId ?? previous.activeCommentId,
                  previous,
                );
              }
              if (!transaction.docChanged) return previous;
              // Use the latest list the page pushed (a comment may have been
              // added/edited while typing); `options.comments` is the mount-time
              // snapshot and would re-report quotes the page already adopted.
              return commentStateFor(
                transaction.doc,
                previous.comments,
                previous.activeCommentId,
                previous,
              );
            },
          },
          view() {
            let lastCaretCommentId: string | null = null;
            const reportCaret = (view: EditorView): void => {
              const id = caretCommentIdOf(view);
              if (id === lastCaretCommentId) return;
              lastCaretCommentId = id;
              options.onCommentAtCaretChange?.(id);
            };
            return {
              update(view, previousState) {
                const current = commentPluginKey.getState(view.state);
                if (current === undefined) return;
                // Selection-only changes still move the active comment, so this
                // runs before the paint short-circuit.
                reportCaret(view);
                if (commentPluginKey.getState(previousState) === current) return;
                paintCommentHighlights(view, current);
                if (current.pendingQuotes.length > 0) {
                  options.onCommentQuotesChange?.(current.pendingQuotes);
                }
              },
              destroy() {
                clearCommentPaint();
              },
            };
          },
          props: {
            handleClick(view, pos) {
              const state = commentPluginKey.getState(view.state);
              if (state === undefined) return false;
              const index = documentTextIndex(view.state.doc);
              for (const [, anchor] of state.anchors) {
                const range = rangeOfAnchor(index, anchor);
                if (range !== null && pos >= range.from && pos <= range.to) {
                  options.onCommentedTextClick?.();
                  return false;
                }
              }
              return false;
            },
          },
        }),
      ];
    },
  });
}