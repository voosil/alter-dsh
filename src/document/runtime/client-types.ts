/**
 * Structural document-client types used by the document runtime.
 *
 * The vendored UI owns `SpaceService`; the document model is an additive
 * capability attached at assembly time (`documentModelOf`). Keeping the
 * structural type here avoids importing the browser RPC implementation into
 * the runtime's pure modules.
 *
 * @module @alter-dsh/space/document/runtime/client-types
 */
/** Structural asset-import surface of the document client. */
export interface DocumentAssetImporter {
  importAsset?(input: {
    mime: string;
    dataBase64: string;
    name?: string;
  }): Promise<{ assetId: string; mime: string; bytes: number }>;
  importFile?(input: {
    mime: string;
    dataBase64: string;
    name?: string;
  }): Promise<{ assetId: string; mime: string; bytes: number; name?: string }>;
}

/** Structural document client the page needs (see `SpaceDocumentClient`). */
export interface DocumentClient extends DocumentAssetImporter {
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
