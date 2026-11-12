/**
 * Canonical helpers shared by the AST ↔ Tiptap mapping and the block diff.
 *
 * The Host stores inline content in a canonical form: adjacent text runs with
 * the same mark set are merged and marks follow the registry order (see
 * `docs/specs/document-model-v0.md` §4). Both the editor projection and the
 * diff must compare against that form, otherwise a no-op round-trip would look
 * like a content change. Keeping the normalization in one module avoids the
 * mapping and the diff drifting apart.
 *
 * @module @alter-dsh/space/document/runtime/canonical
 */
import type { BlockNode, InlineNode, Mark } from '../types';

/** Canonical mark order, matching the Host registry / markdown projection. */
export const MARK_ORDER = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
] as const;

/** One mark type name as understood by the Alter AST. */
export type AlterMarkType = (typeof MARK_ORDER)[number];

/** Only safe link targets may enter the document (spec §4). */
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

/** Whether a value is an href the Host will accept for a `link` mark. */
export function isSafeHref(value: unknown): value is string {
  return typeof value === 'string' && SAFE_HREF.test(value);
}

/** Sort and de-duplicate marks in canonical order, dropping unsafe links. */
export function sortMarks(marks: readonly Mark[]): Mark[] {
  const sorted = [...marks].sort(
    (left, right) => MARK_ORDER.indexOf(left.type) - MARK_ORDER.indexOf(right.type),
  );
  const seen = new Set<string>();
  const result: Mark[] = [];
  for (const mark of sorted) {
    if (seen.has(mark.type)) continue;
    seen.add(mark.type);
    if (mark.type === 'link') {
      const href = mark.attrs?.href;
      if (!isSafeHref(href)) continue;
      result.push({ type: 'link', attrs: { href } });
    } else {
      result.push({ type: mark.type });
    }
  }
  return result;
}

/** Stable identity of one mark set, independent of declaration order. */
export function markKey(marks: readonly Mark[] | undefined): string {
  if (marks === undefined || marks.length === 0) return '';
  return marks
    .map((mark) =>
      mark.type === 'link'
        ? `link:${mark.attrs?.href ?? ''}`
        : `${mark.type}:`,
    )
    .sort()
    .join('|');
}

/** Merge adjacent text runs with the same marks and order marks canonically. */
export function canonicalInline(content: InlineNode[] | undefined): InlineNode[] {
  if (content === undefined) return [];
  const result: InlineNode[] = [];
  for (const node of content) {
    if (node.type === 'hardBreak') {
      result.push({ type: 'hardBreak' });
      continue;
    }
    if (typeof node.text !== 'string' || node.text === '') continue;
    const marks =
      node.marks === undefined || node.marks.length === 0
        ? undefined
        : sortMarks(node.marks);
    const previous = result[result.length - 1];
    if (
      previous !== undefined &&
      previous.type === 'text' &&
      markKey(previous.marks) === markKey(marks)
    ) {
      previous.text += node.text;
      continue;
    }
    result.push(
      marks === undefined
        ? { type: 'text', text: node.text }
        : { type: 'text', text: node.text, marks },
    );
  }
  return result;
}

/** A comparable string key of canonicalized inline content. */
export function inlineKey(content: InlineNode[] | undefined): string {
  return JSON.stringify(canonicalInline(content));
}

/** Structural JSON equality that ignores object key order. */
export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(rightRecord, key) &&
      deepEqualJson(leftRecord[key], rightRecord[key]),
  );
}

/** Whether two blocks are structurally identical (ids included). */
export function blocksEqual(left: BlockNode, right: BlockNode): boolean {
  if (left.id !== right.id || left.type !== right.type) return false;
  if (!deepEqualJson(left.attrs ?? {}, right.attrs ?? {})) return false;
  if (inlineKey(left.content) !== inlineKey(right.content)) return false;
  const leftChildren = left.children ?? [];
  const rightChildren = right.children ?? [];
  if (leftChildren.length !== rightChildren.length) return false;
  return leftChildren.every((child, index) =>
    blocksEqual(child, rightChildren[index]!),
  );
}
