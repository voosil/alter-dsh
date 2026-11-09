/**
 * Browser URL helper for content-addressed document assets.
 *
 * Keep the path in sync with the Host route (`host/document/assets.ts`
 * `ASSET_ROUTE_PATH`); DSH Connection authenticates the request.
 *
 * @module @alter-dsh/space/document/asset-url
 */
export const ASSET_ROUTE_PATH = '/api/alter-space/asset';

/** Absolute path+query for one asset id. */
export function documentAssetUrl(assetId: string): string {
  return `${ASSET_ROUTE_PATH}?id=${encodeURIComponent(assetId)}`;
}
