/**
 * Content-addressed document assets (images) for the Alter document model.
 *
 * Metadata lives in the `document_assets` sidecar table; bytes live under
 * `<dataDir>/assets/<sha[0:2]>/<sha256>.<ext>` so the database and its daily
 * snapshots stay small. Import is deduplicating: identical bytes map to the
 * same `asset_…` id and are written once.
 *
 * @module @alter-dsh/space/document/assets
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpaceStoreHandle } from '../store.js';
import {
  DocumentError,
  type DocumentAssetRecord,
} from './types.js';

/** Subdirectory of the Space data directory that stores asset bytes. */
export const ASSETS_DIR_NAME = 'assets';
/** Exact Fetch route path that serves asset bytes to the browser. */
export const ASSET_ROUTE_PATH = '/api/alter-space/asset';
/** Maximum accepted asset size (4 MiB). */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** One validated import request. */
export interface ImportAssetInput {
  data: Uint8Array;
  mime: string;
  name?: string;
}

/** Read result returned to the Fetch route. */
export interface StoredAsset {
  record: DocumentAssetRecord;
  data: Uint8Array;
}

export interface DocumentAssetsOptions {
  store: SpaceStoreHandle;
  /** Space data directory (the one that owns `space.db`). */
  directory: string;
  now?: () => Date;
}

export interface DocumentAssets {
  /** Validate, deduplicate and persist one asset; resolves to its record. */
  import(input: ImportAssetInput): Promise<DocumentAssetRecord>;
  /** Look up metadata only. */
  get(assetId: string): Promise<DocumentAssetRecord | undefined>;
  /** Read metadata and bytes for the Fetch route. */
  read(assetId: string): Promise<StoredAsset | undefined>;
}

function extensionOf(mime: string): string | undefined {
  return MIME_EXTENSIONS[mime];
}

function assetIdOf(sha256: string): string {
  return `asset_${sha256.slice(0, 32)}`;
}

/** Absolute path of one asset file (callers must not expose it to clients). */
export function assetFilePath(
  directory: string,
  record: Pick<DocumentAssetRecord, 'sha256' | 'mime'>,
): string {
  const extension = extensionOf(record.mime) ?? 'bin';
  return join(
    directory,
    ASSETS_DIR_NAME,
    record.sha256.slice(0, 2),
    `${record.sha256}.${extension}`,
  );
}

/**
 * Create the asset store over one opened Space store and data directory.
 * @param options - store handle, data directory and business clock.
 */
export function createDocumentAssets(options: DocumentAssetsOptions): DocumentAssets {
  const { store, directory } = options;
  const now = options.now ?? (() => new Date());

  return {
    async import(input) {
      const mime = input.mime.trim().toLowerCase();
      if (extensionOf(mime) === undefined)
        throw new DocumentError(
          'object/invalid',
          `不支持的资产类型：${input.mime}（允许 png/jpeg/webp/gif）`,
        );
      if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0)
        throw new DocumentError('object/invalid', '资产内容为空');
      if (input.data.byteLength > MAX_ASSET_BYTES)
        throw new DocumentError(
          'object/invalid',
          `资产 ${input.data.byteLength} 字节超过上限 ${MAX_ASSET_BYTES}`,
        );
      const sha256 = createHash('sha256').update(input.data).digest('hex');
      const id = assetIdOf(sha256);
      const file = assetFilePath(directory, { sha256, mime });

      let record = store.getDocumentAsset(id);
      if (record === undefined) {
        await mkdir(join(directory, ASSETS_DIR_NAME, sha256.slice(0, 2)), {
          recursive: true,
          mode: 0o700,
        });
        try {
          await writeFile(file, input.data, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        try {
          await chmod(file, 0o600);
        } catch {
          // Permissions are best-effort on platforms without POSIX modes.
        }
        const created: DocumentAssetRecord = {
          id,
          sha256,
          mime,
          bytes: input.data.byteLength,
          ...(input.name === undefined ? {} : { name: input.name }),
          createdAt: now().toISOString(),
        };
        await store.transactDocument((_data, sidecar) => {
          sidecar.putAsset(created);
        });
        record = store.getDocumentAsset(id) ?? created;
      }
      return record;
    },

    async get(assetId) {
      return store.getDocumentAsset(assetId);
    },

    async read(assetId) {
      const record = store.getDocumentAsset(assetId);
      if (record === undefined) return undefined;
      try {
        const data = await readFile(assetFilePath(directory, record));
        return { record, data: new Uint8Array(data) };
      } catch {
        return undefined;
      }
    },
  };
}
