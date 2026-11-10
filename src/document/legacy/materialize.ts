/**
 * Materialize legacy editor `data:` URLs into content-addressed assets.
 *
 * The pre-rebuild editor stores pasted images (and files) as `data:` URLs in
 * the DOM. Before an AST save the adapter uploads each one through the
 * document client (`importAsset` / `importFile`) and rewrites the element to an
 * `asset_…` reference, so no base64 payload enters the document AST.
 *
 * The function never throws: a failed upload keeps the original element and
 * reports a warning (the parser then degrades it to a visible placeholder).
 *
 * @module @alter-dsh/space/document/legacy/materialize
 */
import { documentAssetUrl } from '../asset-url';

/** Structural asset-import surface of the document client. */
export interface LegacyAssetImporter {
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

/** Result of {@link materializeLegacyAssets}. */
export interface MaterializedLegacyHtml {
  html: string;
  warnings: string[];
}

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/is;
const FILE_DATA_URL = /^data:([^;,]+)?(?:;base64)?,(.*)$/is;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFromName(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return MIME_BY_EXTENSION[name.slice(dot + 1).trim().toLowerCase()];
}

/** Split a base64 data URL into its mime and payload. */
function splitDataUrl(
  value: string,
): { mime: string | undefined; base64: string } | undefined {
  const match = FILE_DATA_URL.exec(value.trim());
  if (match === null) return undefined;
  return { mime: match[1]?.trim().toLowerCase(), base64: match[2] ?? '' };
}

/**
 * Upload every `data:` image/file in one legacy HTML body and rewrite it to an
 * asset reference. Elements that already carry `data-asset-id` are untouched.
 */
export async function materializeLegacyAssets(
  html: string,
  client: LegacyAssetImporter | undefined,
): Promise<MaterializedLegacyHtml> {
  const warnings: string[] = [];
  if (typeof DOMParser === 'undefined') {
    return { html, warnings: ['当前环境无法物化内联资产'] };
  }
  if (client === undefined) {
    return { html, warnings: [] };
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const body = parsed.body;

  for (const image of [...body.querySelectorAll('img')]) {
    if (image.getAttribute('data-asset-id') !== null) continue;
    const src = image.getAttribute('src') ?? '';
    const match = IMAGE_DATA_URL.exec(src.trim());
    if (match === null) continue;
    if (typeof client.importAsset !== 'function') {
      warnings.push('图片上传未启用，内联图片已降级');
      continue;
    }
    try {
      const result = await client.importAsset({
        mime: match[1]!,
        dataBase64: match[2]!,
        ...(image.getAttribute('alt') === null
          ? {}
          : { name: image.getAttribute('alt')! }),
      });
      image.setAttribute('data-asset-id', result.assetId);
      image.setAttribute('src', documentAssetUrl(result.assetId));
    } catch {
      warnings.push('内联图片上传失败，已保留原内容并阻止保存，请重试');
    }
  }

  for (const file of [...body.querySelectorAll('[data-file]')]) {
    if (file.getAttribute('data-asset-id') !== null) continue;
    const raw =
      file.getAttribute('data-href') ??
      file.getAttribute('data-url') ??
      file.getAttribute('href') ??
      '';
    const split = splitDataUrl(raw);
    if (split === undefined) continue;
    if (typeof client.importFile !== 'function') {
      warnings.push('文件上传未启用，内联文件已降级');
      continue;
    }
    const name =
      file.getAttribute('data-name') ??
      file.getAttribute('data-file') ??
      file.getAttribute('data-filename') ??
      '附件';
    const mime = split.mime ?? mimeFromName(name) ?? 'application/octet-stream';
    try {
      const result = await client.importFile({
        mime,
        dataBase64: split.base64,
        name,
      });
      file.setAttribute('data-asset-id', result.assetId);
      file.setAttribute('data-href', documentAssetUrl(result.assetId));
      file.setAttribute('data-name', result.name ?? name);
      file.setAttribute('data-mime', result.mime || mime);
      file.setAttribute('data-bytes', String(result.bytes));
    } catch {
      warnings.push('内联文件上传失败，已保留原内容并阻止保存，请重试');
    }
  }

  return { html: body.innerHTML, warnings };
}
