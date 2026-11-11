/**
 * Defensive readers for document RPC snapshots.
 *
 * The legacy UI talks to the Host through the structural document client; these
 * helpers never throw on unexpected RPC payloads.
 *
 * @module @alter-dsh/space/document/editors/legacy/snapshot
 */
import type { AlterDoc } from '../../types';
import { parseAlterDocContent } from '../../types';

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
  const revision = readRevisionOf(record) ?? readRevisionOf(docRecord);
  if (revision === undefined) return undefined;
  const title = record['title'];
  return {
    doc: rawDoc as AlterDoc,
    revision,
    ...(typeof title === 'string' ? { title } : {}),
  };
}

/** Normalize a snapshot into the controller's full shape (title defaulted). */
export function normalizeSnapshot(
  snapshot: LegacyDocumentSnapshot,
  fallbackTitle: string,
): { doc: AlterDoc; revision: number; title: string } {
  return {
    doc: snapshot.doc,
    revision: snapshot.revision,
    title: snapshot.title ?? fallbackTitle,
  };
}
