/**
 * Garbage collection for document sidecar artifacts.
 *
 * Objects are immutable and referenced by document block attrs; assets are
 * content-addressed images. A row is alive while the current document tree or
 * any retained version snapshot references it. Everything else can be removed
 * safely; asset bytes are deleted together with their metadata row.
 *
 * @module @alter-dsh/space/document/gc
 */
import { rm } from 'node:fs/promises';
import type { SpaceStoreData, SpaceStoreHandle } from '../store.js';
import { assetFilePath } from './assets.js';
import { tryParseAlterDoc, type BlockNode } from './types.js';

export interface DocumentArtifactRefs {
  objectIds: Set<string>;
  assetIds: Set<string>;
}

function collectBlockRefs(
  block: BlockNode,
  refs: DocumentArtifactRefs,
): void {
  const objectId = block.attrs.objectId;
  if (typeof objectId === 'string' && objectId.startsWith('obj_'))
    refs.objectIds.add(objectId);
  const assetId = block.attrs.assetId;
  if (typeof assetId === 'string' && assetId.startsWith('asset_'))
    refs.assetIds.add(assetId);
  if (block.children !== undefined)
    for (const child of block.children) collectBlockRefs(child, refs);
}

/** Collect every object/asset id referenced by current docs and versions. */
export function collectDocumentArtifactRefs(
  data: SpaceStoreData,
): DocumentArtifactRefs {
  const refs: DocumentArtifactRefs = {
    objectIds: new Set(),
    assetIds: new Set(),
  };
  const visitContent = (content: string): void => {
    const doc = tryParseAlterDoc(content);
    if (doc === undefined) return;
    for (const block of doc.blocks) collectBlockRefs(block, refs);
  };
  for (const node of data.nodes) visitContent(node.content);
  for (const version of data.versions) visitContent(version.content);
  return refs;
}

export interface GcResult {
  objectsRemoved: number;
  assetsRemoved: number;
}

export interface GcOptions {
  store: SpaceStoreHandle;
  directory: string;
  logger?: { warn?(message: string): void };
}

/**
 * Remove unreferenced object/asset rows (best-effort, startup maintenance).
 * @param options - store, data directory and optional logger.
 */
export async function gcDocumentArtifacts(
  options: GcOptions,
): Promise<GcResult> {
  const { store, directory } = options;
  const refs = collectDocumentArtifactRefs(store.read());
  const orphanObjects = store
    .listAllDocumentObjects()
    .filter((record) => !refs.objectIds.has(record.id));
  if (orphanObjects.length > 0)
    await store.deleteDocumentObjects(orphanObjects.map((record) => record.id));

  const orphanAssets = store
    .listAllDocumentAssets()
    .filter((record) => !refs.assetIds.has(record.id));
  if (orphanAssets.length > 0) {
    await store.deleteDocumentAssets(orphanAssets.map((record) => record.id));
    for (const record of orphanAssets) {
      try {
        await rm(assetFilePath(directory, record), { force: true });
      } catch {
        // Orphan bytes that cannot be removed are harmless and retried later.
      }
    }
  }
  if (orphanObjects.length > 0 || orphanAssets.length > 0)
    options.logger?.warn?.(
      `[alter-dsh-space] 文档对象/资产 GC：对象 ${orphanObjects.length} 个，资产 ${orphanAssets.length} 个`,
    );
  return {
    objectsRemoved: orphanObjects.length,
    assetsRemoved: orphanAssets.length,
  };
}

export type { BlockNode };
