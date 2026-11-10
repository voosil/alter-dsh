/**
 * Access the optional document-model client attached to the Space service.
 *
 * The Host half owns document content; the plugin assembly attaches a
 * `document` capability to the Space service so views can write through
 * Document Operations without the vendored interface depending on `src/`.
 *
 * The restored pre-rebuild document UI uses this client as its data layer: it
 * loads AST snapshots, saves block diffs, materializes pasted assets and
 * restores versions through the document model instead of writing
 * `node.content` directly.
 *
 * @module @alter/ui-space/document-model
 */
import type { SpaceService } from '@alter/protocol';

/** One asset-import result (mirrors `doc.importAsset`). */
export interface SpaceDocumentAsset {
  assetId: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** One file-import result (mirrors `doc.importFile`). */
export interface SpaceDocumentFile {
  assetId: string;
  mime: string;
  bytes: number;
  name?: string;
}

/** Minimal document-client surface the Space views need. */
export interface SpaceDocumentModelClient {
  /** Append Markdown blocks to one existing AST document. */
  generate(input: {
    docId: string;
    markdown: string;
    title?: string;
  }): Promise<unknown>;
  /** Read the canonical AST snapshot of one document. */
  get(docId: string): Promise<unknown>;
  /** Apply one Document-Operations batch against a base revision. */
  applyOperations(input: {
    docId: string;
    baseRevision: number;
    ops: unknown[];
    idempotencyKey?: string;
  }): Promise<unknown>;
  /** Import one inline image as a content-addressed asset. */
  importAsset?(input: {
    mime: string;
    dataBase64: string;
    name?: string;
  }): Promise<SpaceDocumentAsset>;
  /** Import one inline file as a content-addressed asset. */
  importFile?(input: {
    mime: string;
    dataBase64: string;
    name?: string;
  }): Promise<SpaceDocumentFile>;
  /** Restore one historical AST version (bumps the revision). */
  restoreVersion?(input: {
    docId: string;
    versionId: string;
    baseRevision: number;
  }): Promise<unknown>;
  /** Read one structured object payload (mindmap/component). */
  getObject?(objectId: string): Promise<unknown>;
  /** Read the Markdown projection of one document. */
  read?(docId: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** `SpaceService` plus the optional document-model client. */
export type SpaceServiceWithDocument = SpaceService & {
  document?: SpaceDocumentModelClient;
};

/** Read the attached document-model client, when the host exposes it. */
export function documentModelOf(
  service: SpaceService,
): SpaceDocumentModelClient | undefined {
  return (service as SpaceServiceWithDocument).document;
}
