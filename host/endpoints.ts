/**
 * Endpoint classification shared by the remote bridge and the migration lock.
 *
 * Reads may be served from cache while the server is offline and stay allowed
 * during a migration freeze; every other endpoint mutates state and must reach
 * the active authority.
 *
 * @module @alter-dsh/space/endpoints
 */

/** Business endpoints that never mutate the authority. */
export const READ_ENDPOINTS: ReadonlySet<string> = new Set([
  'space.listSpaces',
  'space.getSpace',
  'space.listArchivedSpaces',
  'space.listNodes',
  'space.getNode',
  'space.listComments',
  'space.listVersions',
  'space.listThoughts',
  'space.listDeleted',
  'space.search',
  'space.getOverview',
  'space.listAgents',
  'space.listDirectories',
  'hub.get',
  'storage.get',
  'storage.estimate',
  'doc.get',
  'doc.outline',
  'doc.read',
  'doc.search',
  'object.get',
]);

/** Whether one endpoint only reads authority state. */
export function isReadEndpoint(endpoint: string): boolean {
  return READ_ENDPOINTS.has(endpoint);
}
