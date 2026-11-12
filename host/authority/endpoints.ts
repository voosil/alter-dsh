/**
 * Endpoint classification shared by the remote bridge and the migration lock.
 *
 * Reads may be served from cache while the server is offline and stay allowed
 * during a migration freeze; every other endpoint mutates state and must reach
 * the active authority.
 *
 * The read set is derived from the capability ledger
 * (`host/authority/capabilities.ts`), the single source of truth for the
 * operation surface; the parity gate keeps ledger and whitelists in sync.
 *
 * @module @alter-dsh/space/authority/endpoints
 */
import { businessReadEndpoints } from './capabilities.js';

/** Business endpoints that never mutate the authority. */
export const READ_ENDPOINTS: ReadonlySet<string> = businessReadEndpoints();

/** Whether one endpoint only reads authority state. */
export function isReadEndpoint(endpoint: string): boolean {
  return READ_ENDPOINTS.has(endpoint);
}
