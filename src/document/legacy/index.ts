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
 * - `computeAstOperations` re-exports the block-level diff used for saves;
 * - `anchorForQuote` maps a comment quote to a top-level block anchor.
 *
 * @module @alter-dsh/space/document/legacy
 */
import { computeOperations } from '../editor/operations';
import type { AlterDoc, BlockNode, InlineNode } from '../types';
import { parseAlterDocContent } from '../types';
import type { LegacyAssetImporter } from './materialize';

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

/** Comment anchor shape stored on one top-level block. */
export interface LegacyCommentAnchor {
  blockId: string;
  offset: number;
  length: number;
}

/** Structural document client the legacy UI needs (see `SpaceDocumentClient`). */
export interface LegacyDocumentClient extends LegacyAssetImporter {
  get(docId: string): Promise<unknown>;
  applyOperations(input: {
    docId: string;
    baseRevision: number;
    ops: unknown[];
    idempotencyKey?: string;
  }): Promise<unknown>;
  restoreVersion?(input: {
    docId: string;
    versionId: string;
    baseRevision: number;
  }): Promise<unknown>;
  getObject?(objectId: string): Promise<unknown>;
  read?(docId: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** One `doc.get` / version snapshot read defensively from an RPC result. */
export interface LegacyDocumentSnapshot {
  doc: AlterDoc;
  revision: number;
  title?: string;
}

/** Parse stored node content into an AST document (undefined when invalid). */
export function parseDocumentContent(content: string): AlterDoc | undefined {
  return parseAlterDocContent(content);
}

/** Serialize an AST document back into stored node content. */
export function serializeDocument(doc: AlterDoc): string {
  return JSON.stringify(doc);
}

/** Read a non-negative integer revision from an RPC result. */
export function readRevisionOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const revision = (value as Record<string, unknown>)['revision'];
  return typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 0
    ? revision
    : undefined;
}

/** Read one document snapshot (`{doc, revision, title}`) defensively. */
export function readDocumentSnapshot(
  value: unknown,
): LegacyDocumentSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const rawDoc = record['doc'];
  if (typeof rawDoc !== 'object' || rawDoc === null) return undefined;
  const docRecord = rawDoc as Record<string, unknown>;
  if (docRecord['format'] !== 'alter-doc/1') return undefined;
  if (!Array.isArray(docRecord['blocks'])) return undefined;
  const revision =
    readRevisionOf(record) ?? readRevisionOf(docRecord);
  if (revision === undefined) return undefined;
  const title = record['title'];
  return {
    doc: rawDoc as AlterDoc,
    revision,
    ...(typeof title === 'string' ? { title } : {}),
  };
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
