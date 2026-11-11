/**
 * Exact Fetch route that serves content-addressed document assets.
 *
 * The route sits under `/api` so DSH Connection owns browser authentication and
 * the Host/Origin fence; the handler only validates the id and streams bytes.
 * Images are served inline for `<img>` rendering; every other file asset is
 * served as an attachment so the browser downloads it with its display name.
 *
 * @module @alter-dsh/space/document/asset-route
 */
import { isImageMime, type DocumentAssets } from './asset-store.js';
import { DocumentError, type DocumentAssetRecord } from './editors/legacy/types.js';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** Longest filename kept in the Content-Disposition header. */
const MAX_DISPOSITION_NAME = 200;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Percent-encode one filename for the RFC 5987 `filename*` parameter. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build an `attachment` Content-Disposition value. The quoted fallback is
 * ASCII-only and strips quotes/backslashes, while the UTF-8 name travels
 * percent-encoded, so neither path can inject CRLF or header syntax.
 */
function attachmentDisposition(record: DocumentAssetRecord): string {
  const raw = (record.name?.trim() || record.id).slice(0, MAX_DISPOSITION_NAME);
  const fallback = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(raw)}`;
}

/**
 * Create the asset GET handler for one asset store.
 * @param assets - the content-addressed asset store.
 */
export function createDocumentAssetRoute(assets: DocumentAssets) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET')
      return json(405, { error: 'method_not_allowed' });
    let assetId = '';
    try {
      assetId = new URL(request.url).searchParams.get('id') ?? '';
    } catch {
      return json(400, { error: 'invalid_url' });
    }
    if (assetId === '') return json(400, { error: 'missing_id' });
    try {
      const asset = await assets.read(assetId);
      if (asset === undefined) return json(404, { error: 'not_found' });
      const body = asset.data;
      const inline = isImageMime(asset.record.mime);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': asset.record.mime,
          'content-length': String(asset.record.bytes),
          'cache-control': IMMUTABLE_CACHE,
          'x-content-type-options': 'nosniff',
          ...(inline
            ? {}
            : { 'content-disposition': attachmentDisposition(asset.record) }),
        },
      });
    } catch (error) {
      if (error instanceof DocumentError)
        return json(400, { error: error.code, message: error.message });
      return json(500, { error: 'asset_failure' });
    }
  };
}
