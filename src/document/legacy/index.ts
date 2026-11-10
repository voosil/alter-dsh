/**
 * AST ↔ legacy contentEditable editor adapter.
 *
 * The pre-rebuild Space document UI (restored from the old tree) keeps its
 * DOM/CSS and edits HTML. This module is the seam that lets it edit the
 * authoritative `alter-doc/1` AST:
 *
 * - `alterDocToEditorHtml` projects AST blocks into the editor's HTML syntax;
 * - `parseLegacyHtml` parses that HTML (plus editor-created legacy nodes) back
 *   into AST blocks, reusing `data-block-id` ids;
 * - `materializeLegacyAssets` uploads inline `data:` images/files before a save;
 * - `createLegacySaveController` owns the debounce/single-flight/conflict/draft
 *   save lifecycle;
 * - `anchorForQuote` maps a comment quote to a top-level block anchor.
 *
 * @module @alter-dsh/space/document/legacy
 */
import { computeOperations } from '../editor/operations';
import type { AlterDoc, BlockNode, InlineNode } from '../types';

export {
  alterDocToEditorHtml,
  formatFileSize,
  renderInline,
  type AlterDocToHtmlOptions,
} from './to-html';
export {
  parseLegacyHtml,
  type LegacyFileAsset,
  type LegacyHtmlParseResult,
  type LegacyHtmlParserOptions,
} from './html-parser';
export {
  materializeLegacyAssets,
  type LegacyAssetImporter,
  type MaterializedLegacyHtml,
} from './materialize';
export {
  LEGACY_DRAFT_FORMAT,
  LEGACY_DRAFT_STORAGE_PREFIX,
  blocksContentEquivalent,
  blocksEquivalent,
  clearLegacyDraft,
  defaultDraftStorage,
  draftBlocks,
  legacyDraftMatchesSnapshot,
  legacyDraftStorageKey,
  normalizeTitle,
  parseLegacyDraft,
  readLegacyDraft,
  writeLegacyDraft,
  type LegacyDocumentDraft,
  type LegacyDocumentDraftPayload,
  type LegacyDraftStorage,
} from './draft';
export {
  LEGACY_DRAFT_WRITE_INTERVAL_MS,
  LEGACY_SAVE_DEBOUNCE_MS,
  createLegacySaveController,
  describeLegacySaveError,
  type LegacySaveController,
  type LegacySaveControllerOptions,
  type LegacySaveOutcome,
  type LegacySaveSnapshot,
  type LegacySaveStatus,
} from './save-controller';
export {
  normalizeSnapshot,
  parseDocumentContent,
  readDocumentSnapshot,
  readRevisionOf,
  serializeDocument,
  type LegacyDocumentSnapshot,
} from './snapshot';
export type { LegacyDocumentClient } from './client-types';

/** Comment anchor shape stored on one top-level block. */
export interface LegacyCommentAnchor {
  blockId: string;
  offset: number;
  length: number;
}

/** Plain text of one top-level block, using the comment-anchor convention. */
export function blockPlainText(block: BlockNode): string {
  const parts: string[] = [];
  const collectInline = (content: InlineNode[] | undefined): void => {
    for (const node of content ?? []) {
      parts.push(node.type === 'text' ? node.text : '\n');
    }
  };
  collectInline(block.content);
  for (const child of block.children ?? []) {
    if (parts.length > 0) parts.push('\n');
    parts.push(blockPlainText(child));
  }
  return parts.join('');
}

/** Quote offsets inside one plain text (exact, then whitespace-insensitive). */
function findQuoteOffsets(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  const normalized = quote.trim();
  if (normalized === '') return null;
  const index = text.indexOf(normalized);
  if (index >= 0) return { start: index, end: index + normalized.length };
  const compact = normalized.replace(/\s+/g, '');
  if (compact === '') return null;
  let stripped = '';
  const offsets: number[] = [];
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position] ?? '';
    if (/\s/.test(character)) continue;
    stripped += character;
    offsets.push(position);
  }
  const compactIndex = stripped.indexOf(compact);
  if (compactIndex < 0) return null;
  const start = offsets[compactIndex];
  const end = offsets[compactIndex + compact.length - 1];
  if (start === undefined || end === undefined) return null;
  return { start, end: end + 1 };
}

/**
 * Map one comment quote to a top-level block anchor.
 *
 * The quote must match exactly one top-level block (the pre-rebuild comment
 * model anchors comments to a block range); ambiguous or missing matches
 * return null so the comment is stored without an anchor.
 */
export function anchorForQuote(
  blocks: readonly BlockNode[],
  quote: string | null | undefined,
): LegacyCommentAnchor | null {
  const normalized = (quote ?? '').trim();
  if (normalized === '') return null;
  const matches: LegacyCommentAnchor[] = [];
  for (const block of blocks) {
    const offsets = findQuoteOffsets(blockPlainText(block), normalized);
    if (offsets === null) continue;
    matches.push({
      blockId: block.id,
      offset: offsets.start,
      length: offsets.end - offsets.start,
    });
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Block-level Document-Operations diff used for one legacy save. */
export function computeAstOperations(
  oldDoc: AlterDoc,
  newDoc: AlterDoc,
  limit?: number,
): ReturnType<typeof computeOperations> {
  return computeOperations(oldDoc, newDoc, limit);
}

/** AST types re-exported for adapter consumers. */
export type { AlterDoc, BlockNode, InlineNode, JsonValue } from '../types';
