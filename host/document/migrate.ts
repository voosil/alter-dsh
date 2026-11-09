/**
 * One-way migration of legacy HTML documents into the Alter AST format.
 *
 * The conversion is semantic, not pixel-perfect: paragraphs, headings, lists,
 * quotes, code, tables, inline marks and inline data-URL images are preserved;
 * colors, alignment and unknown structures degrade to plain content. Old HTML
 * versions stay in version history and are rejected by AST-only operations.
 *
 * @module @alter-dsh/space/document/migrate
 */
import { randomUUID } from 'node:crypto';
import { trimTouchedVersions } from '../retention.js';
import type { SpaceStoreData, SpaceStoreHandle } from '../store.js';
import type { DocumentAssets } from './assets.js';
import { parseLegacyHtml } from './html-migration.js';
import { validateAlterDoc } from './schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  parseAlterDoc,
  serializeAlterDoc,
  type AlterDoc,
  type BlockNode,
} from './types.js';

const DATA_URL_PATTERN =
  /data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)/gi;

function newBlockId(): string {
  return `blk_${randomUUID().replaceAll('-', '')}`;
}

export interface MigrateDocumentResult {
  docId: string;
  migrated: boolean;
  reason?: string;
  revision?: number;
  assetsImported: number;
  warnings: string[];
}

export interface MigrateBatchResult {
  migrated: number;
  skipped: number;
  failed: Array<{ docId: string; message: string }>;
  assetsImported: number;
  warnings: string[];
}

export interface DocumentMigration {
  /** Migrate one document; `already-ast`/`not-found` are explicit results. */
  migrateDocument(docId: string): Promise<MigrateDocumentResult>;
  /** Migrate every legacy note (searches, does not delete anything). */
  migrateAll(): Promise<MigrateBatchResult>;
  /** Count legacy notes that still need migration. */
  countLegacy(): number;
}

export interface DocumentMigrationOptions {
  store: SpaceStoreHandle;
  assets: DocumentAssets;
  now?: () => Date;
  logger?: { warn?(message: string): void };
}

function isLegacyNode(content: string): boolean {
  return parseAlterDoc(content).kind === 'legacy';
}

/** Import every inline data-URL image once and return dataURL → asset id. */
async function importEmbeddedImages(
  assets: DocumentAssets,
  html: string,
): Promise<{
  ids: Map<string, string>;
  imported: number;
  warnings: string[];
}> {
  const ids = new Map<string, string>();
  const warnings: string[] = [];
  let imported = 0;
  for (const match of html.matchAll(DATA_URL_PATTERN)) {
    const dataUrl = match[0];
    if (ids.has(dataUrl)) continue;
    const mime = match[1]!.toLowerCase();
    try {
      const buffer = Buffer.from(match[2]!, 'base64');
      if (buffer.byteLength === 0) continue;
      const record = await assets.import({ data: new Uint8Array(buffer), mime });
      ids.set(dataUrl, record.id);
      imported += 1;
    } catch (error) {
      warnings.push(
        `图片导入失败（${mime}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ids, imported, warnings };
}

function recordMigrationVersion(
  data: SpaceStoreData,
  docId: string,
  title: string,
  content: string,
  at: string,
  settings: ReturnType<SpaceStoreHandle['getStorageSettings']>,
): void {
  const previousLength = data.versions.length;
  data.versions.push({
    id: `ver-${randomUUID()}`,
    docId,
    title,
    content,
    author: 'me',
    at,
  });
  trimTouchedVersions(data, previousLength, settings);
}

/**
 * Create the migration service over one opened store and asset store.
 * @param options - store, assets, business clock.
 */
export function createDocumentMigration(
  options: DocumentMigrationOptions,
): DocumentMigration {
  const { store, assets } = options;
  const now = options.now ?? (() => new Date());

  function countLegacy(): number {
    return store
      .read()
      .nodes.filter(
        (node) =>
          node.deletedAt === null &&
          node.kind === 'note' &&
          isLegacyNode(node.content),
      ).length;
  }

  async function migrateDocument(docId: string): Promise<MigrateDocumentResult> {
    const node = store
      .read()
      .nodes.find((item) => item.id === docId && item.deletedAt === null);
    if (node === undefined)
      throw new DocumentError('doc/not-found', '文档不存在或已删除');
    const stored = parseAlterDoc(node.content);
    if (stored.kind === 'alter-doc')
      return {
        docId,
        migrated: false,
        reason: 'already-ast',
        assetsImported: 0,
        warnings: [],
      };

    const { ids, imported, warnings } = await importEmbeddedImages(
      assets,
      node.content,
    );
    const blocks: BlockNode[] = parseLegacyHtml(node.content, {
      createBlockId: newBlockId,
      assetIdFor: (dataUrl) => ids.get(dataUrl),
    });
    const at = now().toISOString();
    const doc: AlterDoc = {
      format: ALTER_DOC_FORMAT,
      schemaVersion: ALTER_DOC_SCHEMA_VERSION,
      revision: 1,
      blocks,
    };
    validateAlterDoc(doc);
    const content = serializeAlterDoc(doc);
    const settings = store.getStorageSettings();

    await store.transactDocument((data) => {
      const current = data.nodes.find(
        (item) => item.id === docId && item.deletedAt === null,
      );
      if (current === undefined)
        throw new DocumentError('doc/not-found', '文档不存在或已删除');
      if (!isLegacyNode(current.content))
        throw new DocumentError('doc/conflict', '文档已被迁移或改写，请刷新后重试');
      current.content = content;
      (current as { contentFormat?: string }).contentFormat = ALTER_DOC_FORMAT;
      current.updatedAt = at;
      current.activityAt = at;
      recordMigrationVersion(data, docId, current.title, content, at, settings);
    });
    if (warnings.length > 0)
      options.logger?.warn?.(
        `[alter-dsh-space] 文档 ${docId} 迁移告警：${warnings.join('；')}`,
      );
    return {
      docId,
      migrated: true,
      revision: 1,
      assetsImported: imported,
      warnings,
    };
  }

  return {
    countLegacy,
    async migrateDocument(docId) {
      return migrateDocument(docId);
    },
    async migrateAll() {
      const legacy = store
        .read()
        .nodes.filter(
          (node) =>
            node.deletedAt === null &&
            node.kind === 'note' &&
            isLegacyNode(node.content),
        )
        .map((node) => node.id);
      const result: MigrateBatchResult = {
        migrated: 0,
        skipped: 0,
        failed: [],
        assetsImported: 0,
        warnings: [],
      };
      for (const docId of legacy) {
        try {
          const one = await migrateDocument(docId);
          if (one.migrated) result.migrated += 1;
          else result.skipped += 1;
          result.assetsImported += one.assetsImported;
          result.warnings.push(...one.warnings);
        } catch (error) {
          result.failed.push({
            docId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    },
  };
}
