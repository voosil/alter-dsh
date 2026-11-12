/**
 * Local crash-draft storage for the document page.
 *
 * The draft is a safety net for interrupted edits: it persists the title, the
 * body and the CAS base revision under `alter-space:doc-draft:<docId>`. Every
 * storage failure is swallowed and never breaks editing.
 *
 * The stored payload is canonical AST blocks, so a draft is independent of any
 * editor implementation; restoring one feeds the same document the server path
 * does.
 *
 * @module @alter-dsh/space/document/runtime/draft
 */
import { blocksEqual, deepEqualJson, inlineKey } from './canonical';
import type { AlterDoc, BlockNode } from '../types';

/** Current draft format: canonical AST blocks. */
export const DRAFT_FORMAT = 'alter-doc-draft/2';

/** Prefix of the per-document draft key. */
export const DRAFT_STORAGE_PREFIX = 'alter-space:doc-draft:';

/** One persisted draft. */
export interface DocumentDraft {
  format: typeof DRAFT_FORMAT;
  docId: string;
  /** Canonical AST blocks exactly as the kernel captured them. */
  blocks: BlockNode[];
  /** Title as typed (not trimmed). */
  title: string;
  /** Revision the draft content is based on (the CAS base of the next save). */
  baseRevision: number;
  /** Epoch milliseconds of the last draft write. */
  savedAt: number;
}

/** Draft payload before the controller stamps `savedAt`. */
export type DocumentDraftPayload = Omit<DocumentDraft, 'savedAt'>;

/** Minimal storage surface (injectable for tests). */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Default storage: `localStorage`, or nothing when unavailable. */
export function defaultDraftStorage(): DraftStorage | undefined {
  try {
    return globalThis.localStorage as DraftStorage | undefined;
  } catch {
    return undefined;
  }
}

/** Storage key of one document's draft. */
export function draftStorageKey(docId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${docId}`;
}

/** Trim a title the same way the save pipeline does. */
export function normalizeTitle(title: string | null | undefined): string {
  return typeof title === 'string' ? title.trim() : '';
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isBlockLike(value: unknown): value is BlockNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlockNode).id === 'string' &&
    typeof (value as BlockNode).type === 'string'
  );
}

/**
 * Parse one stored draft payload.
 *
 * Unknown/invalid payloads return `undefined` (the caller treats that as "no
 * draft"), so a foreign or corrupted entry can never block opening a document.
 */
export function parseDocumentDraft(value: unknown): DocumentDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['format'] !== DRAFT_FORMAT) return undefined;
  const docId = record['docId'];
  if (typeof docId !== 'string' || docId === '') return undefined;
  const title = record['title'];
  if (typeof title !== 'string') return undefined;
  if (!isRevision(record['baseRevision'])) return undefined;
  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  const blocks = record['blocks'];
  if (!Array.isArray(blocks) || !blocks.every(isBlockLike)) return undefined;
  return {
    format: DRAFT_FORMAT,
    docId,
    blocks: blocks as BlockNode[],
    title,
    baseRevision: record['baseRevision'],
    savedAt,
  };
}

/** Read the draft of one document, or undefined when absent/unreadable. */
export function readDocumentDraft(
  docId: string,
  storage: DraftStorage | undefined = defaultDraftStorage(),
): DocumentDraft | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(draftStorageKey(docId));
    if (raw === null) return undefined;
    const draft = parseDocumentDraft(JSON.parse(raw) as unknown);
    if (draft === undefined || draft.docId !== docId) return undefined;
    return draft;
  } catch {
    return undefined;
  }
}

/** Persist one draft; quota/privacy failures are swallowed (best effort). */
export function writeDocumentDraft(
  draft: DocumentDraft,
  storage: DraftStorage | undefined = defaultDraftStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(draftStorageKey(draft.docId), JSON.stringify(draft));
  } catch {
    // Drafts are a safety net, never a reason to break the editor.
  }
}

/** Remove the draft of one document. */
export function clearDraft(
  docId: string,
  storage: DraftStorage | undefined = defaultDraftStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.removeItem(draftStorageKey(docId));
  } catch {
    // Ignore storage failures.
  }
}

function blockContentEquivalent(left: BlockNode, right: BlockNode): boolean {
  if (left.type !== right.type) return false;
  if (!deepEqualJson(left.attrs ?? {}, right.attrs ?? {})) return false;
  if (inlineKey(left.content) !== inlineKey(right.content)) return false;
  return blocksContentEquivalent(left.children ?? [], right.children ?? []);
}

/**
 * Content equality of two top-level block lists, ignoring block ids.
 *
 * Ids can be assigned by the Host on insert, so a draft captured before a save
 * may lack the ids the Host stored; content equality is what "the Host already
 * has what we tried to write" means.
 */
export function blocksContentEquivalent(
  left: readonly BlockNode[],
  right: readonly BlockNode[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((block, index) =>
    blockContentEquivalent(block, right[index]!),
  );
}

/** Structural equality of two top-level block lists (ids included). */
export function blocksEquivalent(
  left: readonly BlockNode[],
  right: readonly BlockNode[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((block, index) => blocksEqual(block, right[index]!));
}

/**
 * Whether the draft is already represented by the server snapshot.
 *
 * Used on load to reconcile a draft whose save actually landed but whose
 * receipt was lost: the draft then matches the snapshot and is discarded
 * silently instead of asking the user to resolve a phantom conflict.
 */
export function draftMatchesSnapshot(
  draft: DocumentDraft,
  snapshot: { doc: AlterDoc; title: string },
): boolean {
  if (normalizeTitle(draft.title) !== normalizeTitle(snapshot.title)) {
    return false;
  }
  return blocksContentEquivalent(draft.blocks, snapshot.doc.blocks);
}