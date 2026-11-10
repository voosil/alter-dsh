/**
 * Local crash-recovery drafts for AST documents.
 *
 * The Host stays authoritative; a draft is only the local safety net for edits
 * that have not been confirmed saved yet. Drafts live in `localStorage` under
 * one key per document so a crash, a forced quit or a lost network round-trip
 * can always be recovered (see P0 save lifecycle).
 *
 * Everything here is plain data + guards so the format and the snapshot
 * comparison can be unit tested without a browser (storage is injectable and
 * `localStorage` may be absent under SSR/tests).
 *
 * @module @alter-dsh/space/document/editor/draft
 */
import type { JSONContent } from '@tiptap/core';
import type { AlterDoc, BlockNode } from '../types';
import { blocksEqual, deepEqualJson, inlineKey } from './canonical';
import { tiptapToBlocks } from './mapping';

/** Format marker so stale/foreign payloads are never restored. */
export const DRAFT_FORMAT = 'alter-doc-draft/1';

/** Prefix of the per-document draft key. */
export const DRAFT_STORAGE_PREFIX = 'alter-space:doc-draft:';

/** One persisted editor draft. */
export interface DocumentDraft {
  format: typeof DRAFT_FORMAT;
  docId: string;
  /** Title as typed (not trimmed). */
  title: string;
  /** Exact Tiptap JSON, so a restore does not depend on an AST round-trip. */
  editor: JSONContent;
  /** Revision the draft content is based on (the CAS base of the next save). */
  baseRevision: number;
  /** Revision last confirmed saved by this editor session. */
  savedRevision: number;
  /** Epoch milliseconds of the last draft write. */
  savedAt: number;
}

/** Draft payload before the controller stamps `savedAt`. */
export type DocumentDraftPayload = Omit<DocumentDraft, 'savedAt'>;

/** localStorage key for one document draft. */
export function draftStorageKey(docId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${docId}`;
}

/** Resolve `localStorage`, tolerating SSR and privacy-mode failures. */
function defaultStorage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Titles are compared/saved trimmed; the input keeps the raw value. */
export function normalizeTitle(title: string | null | undefined): string {
  return typeof title === 'string' ? title.trim() : '';
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate one parsed draft payload; foreign/stale formats are rejected. */
export function parseDocumentDraft(value: unknown): DocumentDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['format'] !== DRAFT_FORMAT) return undefined;
  const docId = record['docId'];
  if (typeof docId !== 'string' || docId === '') return undefined;
  const title = record['title'];
  if (typeof title !== 'string') return undefined;
  const editor = record['editor'];
  if (typeof editor !== 'object' || editor === null) return undefined;
  if (
    !isRevision(record['baseRevision']) ||
    !isRevision(record['savedRevision'])
  )
    return undefined;
  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  return {
    format: DRAFT_FORMAT,
    docId,
    title,
    editor: editor as JSONContent,
    baseRevision: record['baseRevision'],
    savedRevision: record['savedRevision'],
    savedAt,
  };
}

/** Read the draft of one document, or undefined when absent/unreadable. */
export function readDocumentDraft(
  docId: string,
  storage: Storage | undefined = defaultStorage(),
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
  storage: Storage | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(draftStorageKey(draft.docId), JSON.stringify(draft));
  } catch {
    // Drafts are a safety net, never a reason to break the editor.
  }
}

/** Remove the draft of one document. */
export function clearDocumentDraft(
  docId: string,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.removeItem(draftStorageKey(docId));
  } catch {
    // Ignore storage failures.
  }
}

/** Project the draft editor JSON back into AST blocks, or undefined. */
export function draftBlocks(draft: DocumentDraft): BlockNode[] | undefined {
  try {
    return tiptapToBlocks(draft.editor);
  } catch {
    return undefined;
  }
}

/** Structural equality of two top-level block lists (ids included). */
export function blocksEquivalent(
  left: readonly BlockNode[],
  right: readonly BlockNode[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((block, index) => blocksEqual(block, right[index]!));
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
 * Ids are assigned on projection: a draft captured before a save can lack the
 * ids the Host stored for newly inserted blocks, so comparing ids would turn a
 * successfully saved document into a phantom draft/conflict. Content equality
 * is what "the Host already has what we tried to write" means.
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

/**
 * Whether the draft is already represented by the server snapshot.
 *
 * Used on load to reconcile a draft whose save actually landed but whose
 * receipt was lost: the draft then matches the snapshot and is discarded
 * silently instead of asking the user to resolve a phantom conflict.
 */
export function documentDraftMatchesSnapshot(
  draft: DocumentDraft,
  snapshot: { doc: AlterDoc; title: string },
): boolean {
  if (normalizeTitle(draft.title) !== normalizeTitle(snapshot.title)) {
    return false;
  }
  const blocks = draftBlocks(draft);
  if (blocks === undefined) return false;
  return blocksContentEquivalent(blocks, snapshot.doc.blocks);
}
