/**
 * Content-addressed document assets (images and files) for the Alter document
 * model.
 *
 * Metadata lives in the `document_assets` sidecar table; bytes live under
 * `<dataDir>/assets/<sha[0:2]>/<sha256>.<ext>` so the database and its daily
 * snapshots stay small. Import is deduplicating: identical bytes map to the
 * same `asset_…` id and are written once.
 *
 * Images are imported through {@link DocumentAssets.import} (4 MiB limit) and
 * every other downloadable file through {@link DocumentAssets.importFile}
 * (8 MiB limit, explicit mime allowlist). Both share the same layout and
 * content-addressed dedup; the mime stored on the first import wins.
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
/** Maximum accepted image size (4 MiB). */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;
/** Maximum accepted generic file size (8 MiB). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * File-asset allowlist: the image types above plus downloadable documents.
 * HTML, SVG and other inline-executable types must stay out.
 */
const FILE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  ...IMAGE_MIME_EXTENSIONS,
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** One validated import request. */
export interface ImportAssetInput {
  data: Uint8Array;
  mime: string;
  name?: string;
}

/** One file import request; same shape as an image import. */
export type ImportFileInput = ImportAssetInput;

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
  /** Validate, deduplicate and persist one image; resolves to its record. */
  import(input: ImportAssetInput): Promise<DocumentAssetRecord>;
  /** Validate, deduplicate and persist one downloadable file. */
  importFile(input: ImportFileInput): Promise<DocumentAssetRecord>;
  /** Look up metadata only. */
  get(assetId: string): Promise<DocumentAssetRecord | undefined>;
  /** Read metadata and bytes for the Fetch route. */
  read(assetId: string): Promise<StoredAsset | undefined>;
}

/** Whether `mime` is one of the inline-renderable image types. */
export function isImageMime(mime: string): boolean {
  return IMAGE_MIME_EXTENSIONS[mime.trim().toLowerCase()] !== undefined;
}

function extensionOf(mime: string): string | undefined {
  return FILE_MIME_EXTENSIONS[mime];
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

interface ValidatedImport {
  data: Uint8Array;
  mime: string;
  name?: string;
}

/** Validate one image import without touching storage. */
function validateImageInput(input: ImportAssetInput): ValidatedImport {
  const mime = input.mime.trim().toLowerCase();
  if (!isImageMime(mime))
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
  return {
    data: input.data,
    mime,
    ...(input.name === undefined ? {} : { name: input.name }),
  };
}

/** Validate one generic file import without touching storage. */
function validateFileInput(input: ImportFileInput): ValidatedImport {
  const mime = input.mime.trim().toLowerCase();
  if (extensionOf(mime) === undefined)
    throw new DocumentError(
      'object/invalid',
      `不支持的文件类型：${input.mime}（允许 png/jpeg/webp/gif/pdf/txt/md/csv/json/zip/docx/xlsx/pptx）`,
    );
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0)
    throw new DocumentError('object/invalid', '文件内容为空');
  if (input.data.byteLength > MAX_FILE_BYTES)
    throw new DocumentError(
      'doc/too-large',
      `文件 ${input.data.byteLength} 字节超过上限 ${MAX_FILE_BYTES}`,
    );
  return {
    data: input.data,
    mime,
    ...(input.name === undefined ? {} : { name: input.name }),
  };
}

/**
 * Create the asset store over one opened Space store and data directory.
 * @param options - store handle, data directory and business clock.
 */
export function createDocumentAssets(options: DocumentAssetsOptions): DocumentAssets {
  const { store, directory } = options;
  const now = options.now ?? (() => new Date());

  /** Persist one validated import; identical bytes reuse the existing row. */
  async function persist(input: ValidatedImport): Promise<DocumentAssetRecord> {
    const { data, mime } = input;
    const sha256 = createHash('sha256').update(data).digest('hex');
    const id = assetIdOf(sha256);
    const file = assetFilePath(directory, { sha256, mime });

    let record = store.getDocumentAsset(id);
    if (record === undefined) {
      await mkdir(join(directory, ASSETS_DIR_NAME, sha256.slice(0, 2)), {
        recursive: true,
        mode: 0o700,
      });
      try {
        await writeFile(file, data, { flag: 'wx', mode: 0o600 });
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
        bytes: data.byteLength,
        ...(input.name === undefined ? {} : { name: input.name }),
        createdAt: now().toISOString(),
      };
      await store.transactDocument((_data, sidecar) => {
        sidecar.putAsset(created);
      });
      record = store.getDocumentAsset(id) ?? created;
    }
    return record;
  }

  return {
    async import(input) {
      return persist(validateImageInput(input));
    },

    async importFile(input) {
      return persist(validateFileInput(input));
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
