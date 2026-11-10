/**
 * Space service composition for the single-format document model.
 *
 * Every note body is an `alter-doc/1` AST, so note creation must go through
 * {@link DocumentService.createNote} and body writes must go through Document
 * Operations. This wrapper keeps the browser-facing `SpaceService` contract
 * while routing those two paths to the document service.
 *
 * @module @alter-dsh/space/document/notes
 */
import type { SpaceService } from '@alter/protocol';
import type { DocumentService } from './service.js';
import { DocumentError } from './types.js';

/**
 * Wrap a content service so notes are always AST-backed documents.
 * @param service - business service over the Space store.
 * @param document - document service that owns note bodies.
 */
export function createStructuredSpaceService(
  service: SpaceService,
  document: DocumentService,
): SpaceService {
  return {
    ...service,
    async createNode(input) {
      if (input.kind !== 'note') return service.createNode(input);
      return document.createNote({
        spaceId: input.spaceId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      });
    },
    async saveNode(id, patch) {
      if (patch.content !== undefined)
        throw new DocumentError(
          'node/not-writable',
          '文档正文只能通过文档模型接口写入',
        );
      return service.saveNode(id, patch);
    },
  };
}
