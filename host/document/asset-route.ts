/**
 * Exact Fetch route that serves content-addressed document assets.
 *
 * The route sits under `/api` so DSH Connection owns browser authentication and
 * the Host/Origin fence; the handler only validates the id and streams bytes.
 *
 * @module @alter-dsh/space/document/asset-route
 */
import { DocumentError } from './types.js';
import type { DocumentAssets } from './assets.js';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': asset.record.mime,
          'content-length': String(asset.record.bytes),
          'cache-control': IMMUTABLE_CACHE,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      if (error instanceof DocumentError)
        return json(400, { error: error.code, message: error.message });
      return json(500, { error: 'asset_failure' });
    }
  };
}
