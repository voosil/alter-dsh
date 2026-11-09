/**
 * Access the optional document client attached to the Space service.
 *
 * `SpaceService` is the vendored product contract; the document model is an
 * additive DSH capability. Entry assembly attaches the extra client, and the
 * AST document view reads it back without changing the vendored interface.
 *
 * @module @alter-dsh/space/document/client-access
 */
import type { SpaceService } from '@alter/protocol';
import type { SpaceDocumentClient } from '../space-client';

/** `SpaceService` plus the optional document RPC client. */
export type SpaceServiceWithDocument = SpaceService & {
  document?: SpaceDocumentClient;
};

/** Attach the document client to a Space service instance. */
export function attachDocumentClient(
  service: SpaceService,
  document: SpaceDocumentClient,
): SpaceService {
  (service as SpaceServiceWithDocument).document = document;
  return service;
}

/** Read the attached document client, when the Host exposes it. */
export function documentClientOf(
  service: SpaceService,
): SpaceDocumentClient | undefined {
  return (service as SpaceServiceWithDocument).document;
}
