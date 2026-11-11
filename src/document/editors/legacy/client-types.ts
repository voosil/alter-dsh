/**
 * Structural document-client types used by the legacy adapter.
 *
 * The vendored UI owns `SpaceService`; the document model is an additive
 * capability attached at assembly time (`documentModelOf`). Keeping the
 * structural type here avoids importing the browser RPC implementation into
 * the adapter's pure modules.
 *
 * @module @alter-dsh/space/document/editors/legacy/client-types
 */
import type { LegacyAssetImporter } from './materialize';

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
