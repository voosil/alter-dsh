/**
 * Local crash-draft storage for the document page.
 *
 * The draft is a safety net for interrupted edits: it persists the title, the
 * body and the CAS base revision under `alter-space:doc-draft:<docId>`. Every
 * storage failure is swallowed and never breaks editing.
 *
 * Two formats coexist:
 *
 * - `alter-doc-draft/2` stores canonical AST blocks, so a draft is
 *   kernel-independent (an HTML draft could not be restored into an AST-native
 *   editor). This is the only format ever written now;
 * - `alter-doc-legacy-draft/1` is the HTML format written before the kernel
 *   seam existed. It is still read and projected to blocks, so an interrupted
 *   edit from an older build is never lost.
 *
 * @module @alter-dsh/space/document/editors/legacy/draft
 */
import { blocksEqual, deepEqualJson, inlineKey } from './canonical';
import type { AlterDoc, BlockNode } from '../../types';
import { parseLegacyHtml } from './html-parser';

/** Current draft format: canonical AST blocks (kernel-independent). */
export const DRAFT_FORMAT = 'alter-doc-draft/2';

/** Legacy HTML draft format marker; still read, never written. */
export const LEGACY_DRAFT_FORMAT = 'alter-doc-legacy-draft/1';

/** Prefix of the per-document draft key. */
export const LEGACY_DRAFT_STORAGE_PREFIX = 'alter-space:doc-draft:';

/** One persisted draft in the current (block) format. */
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

/** A legacy HTML draft read from storage (projected to blocks on demand). */
export interface LegacyDocumentDraft {
  format: typeof LEGACY_DRAFT_FORMAT;
  docId: string;
  html: string;
  title: string;
  baseRevision: number;
  savedAt: number;
}

/** Any draft the page can restore. */
export type RecoverableDraft = DocumentDraft | LegacyDocumentDraft;

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

function isBlockLike(value: unknown): value is BlockNode {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['type'] === 'string' &&
    typeof record['attrs'] === 'object' &&
    record['attrs'] !== null
  );
}

/**
 * Validate one parsed draft payload.
 *
 * Reads both the current block format and the legacy HTML format; anything
 * else (foreign or corrupted) is rejected so a bad value never surfaces as a
 * "recoverable draft".
 */
export function parseDocumentDraft(value: unknown): RecoverableDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const docId = record['docId'];
  if (typeof docId !== 'string' || docId === '') return undefined;
  const title = record['title'];
  if (typeof title !== 'string') return undefined;
  if (!isRevision(record['baseRevision'])) return undefined;
  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;

  if (record['format'] === DRAFT_FORMAT) {
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
  if (record['format'] === LEGACY_DRAFT_FORMAT) {
    const html = record['html'];
    if (typeof html !== 'string') return undefined;
    return {
      format: LEGACY_DRAFT_FORMAT,
      docId,
      html,
      title,
      baseRevision: record['baseRevision'],
      savedAt,
    };
  }
  return undefined;
}

/** Backwards-compatible name for {@link parseDocumentDraft}. */
export const parseLegacyDraft = parseDocumentDraft;

/** Read the draft of one document, or undefined when absent/unreadable. */
export function readLegacyDraft(
  docId: string,
  storage: LegacyDraftStorage | undefined = defaultDraftStorage(),
): RecoverableDraft | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(legacyDraftStorageKey(docId));
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
  draft: RecoverableDraft,
  storage: LegacyDraftStorage | undefined = defaultDraftStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(legacyDraftStorageKey(draft.docId), JSON.stringify(draft));
  } catch {
    // Drafts are a safety net, never a reason to break the editor.
  }
}

/** Backwards-compatible name for {@link writeDocumentDraft}. */
export const writeLegacyDraft = writeDocumentDraft;

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

/**
 * Blocks of any recoverable draft.
 *
 * Block drafts are already canonical; legacy HTML drafts are projected through
 * the legacy adapter so an interrupted edit from an older build still restores.
 */
export function draftBlocks(draft: RecoverableDraft): BlockNode[] {
  if (draft.format === DRAFT_FORMAT) return draft.blocks;
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
  draft: RecoverableDraft,
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