/**
 * Access the optional document-model client attached to the Space service.
 *
 * The Host half owns document content; the plugin assembly attaches a
 * `document` capability to the Space service so views can write through
 * Document Operations without the vendored interface depending on `src/`.
 *
 * @module @alter/ui-space/document-model
 */
import type { SpaceService } from '@alter/protocol';

/** Minimal document-client surface the Space views need. */
export interface SpaceDocumentModelClient {
  /** Append Markdown blocks to one existing AST document. */
  generate(input: {
    docId: string;
    markdown: string;
    title?: string;
  }): Promise<unknown>;
}

/** `SpaceService` plus the optional document-model client. */
export type SpaceServiceWithDocument = SpaceService & {
  document?: SpaceDocumentModelClient;
};

/** Read the attached document-model client, when the host exposes it. */
export function documentModelOf(
  service: SpaceService,
): SpaceDocumentModelClient | undefined {
  return (service as SpaceServiceWithDocument).document;
}
