/**
 * Local crash-draft storage for the legacy (restored) document UI.
 *
 * The pre-rebuild editor works on HTML; this module persists that HTML plus the
 * title and the CAS base revision under
 * `alter-space:doc-draft:<docId>` so an interrupted edit can be recovered after
 * a reload/crash. Drafts are a safety net only: every storage failure is
 * swallowed and never breaks editing.
 *
 * @module @alter-dsh/space/document/editors/legacy/draft
 */
import { blocksEqual, deepEqualJson, inlineKey } from './canonical';
import type { AlterDoc, BlockNode } from '../../types';
import { parseLegacyHtml } from './html-parser';

/** Draft payload format marker; foreign formats are ignored. */
export const LEGACY_DRAFT_FORMAT = 'alter-doc-legacy-draft/1';

/** Prefix of the per-document draft key. */
export const LEGACY_DRAFT_STORAGE_PREFIX = 'alter-space:doc-draft:';

/** One persisted legacy editor draft. */
export interface LegacyDocumentDraft {
  format: typeof LEGACY_DRAFT_FORMAT;
  docId: string;
  /** Editor HTML exactly as captured (may contain inline data: URLs). */
  html: string;
  /** Title as typed (not trimmed). */
  title: string;
  /** Revision the draft content is based on (the CAS base of the next save). */
  baseRevision: number;
  /** Epoch milliseconds of the last draft write. */
  savedAt: number;
}

/** Draft payload before the controller stamps `savedAt`. */
export type LegacyDocumentDraftPayload = Omit<LegacyDocumentDraft, 'savedAt'>;

/** Minimal storage surface (injectable for tests). */
export interface LegacyDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` when the environment has one. */
export function defaultDraftStorage(): LegacyDraftStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** localStorage key for one document draft. */
export function legacyDraftStorageKey(docId: string): string {
  return `${LEGACY_DRAFT_STORAGE_PREFIX}${docId}`;
}

/** Trim a title the same way the save pipeline does. */
export function normalizeTitle(title: string | null | undefined): string {
  return typeof title === 'string' ? title.trim() : '';
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate one parsed draft payload; foreign/stale formats are rejected. */
export function parseLegacyDraft(
  value: unknown,
): LegacyDocumentDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['format'] !== LEGACY_DRAFT_FORMAT) return undefined;
  const docId = record['docId'];
  if (typeof docId !== 'string' || docId === '') return undefined;
  const html = record['html'];
  if (typeof html !== 'string') return undefined;
  const title = record['title'];
  if (typeof title !== 'string') return undefined;
  if (!isRevision(record['baseRevision'])) return undefined;
  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  return {
    format: LEGACY_DRAFT_FORMAT,
    docId,
    html,
    title,
    baseRevision: record['baseRevision'],
    savedAt,
  };
}

/** Read the draft of one document, or undefined when absent/unreadable. */
export function readLegacyDraft(
  docId: string,
  storage: LegacyDraftStorage | undefined = defaultDraftStorage(),
): LegacyDocumentDraft | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(legacyDraftStorageKey(docId));
    if (raw === null) return undefined;
    const draft = parseLegacyDraft(JSON.parse(raw) as unknown);
    if (draft === undefined || draft.docId !== docId) return undefined;
    return draft;
  } catch {
    return undefined;
  }
}

/** Persist one draft; quota/privacy failures are swallowed (best effort). */
export function writeLegacyDraft(
  draft: LegacyDocumentDraft,
  storage: LegacyDraftStorage | undefined = defaultDraftStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(legacyDraftStorageKey(draft.docId), JSON.stringify(draft));
  } catch {
    // Drafts are a safety net, never a reason to break the editor.
  }
}

/** Remove the draft of one document. */
export function clearLegacyDraft(
  docId: string,
  storage: LegacyDraftStorage | undefined = defaultDraftStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.removeItem(legacyDraftStorageKey(docId));
  } catch {
    // Ignore storage failures.
  }
}

/** Project draft HTML back into AST blocks (ids are irrelevant here). */
export function draftBlocks(draft: LegacyDocumentDraft): BlockNode[] {
  return parseLegacyHtml(draft.html).blocks;
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
export function legacyDraftMatchesSnapshot(
  draft: LegacyDocumentDraft,
  snapshot: { doc: AlterDoc; title: string },
): boolean {
  if (normalizeTitle(draft.title) !== normalizeTitle(snapshot.title)) {
    return false;
  }
  try {
    return blocksContentEquivalent(draftBlocks(draft), snapshot.doc.blocks);
  } catch {
    return false;
  }
}
