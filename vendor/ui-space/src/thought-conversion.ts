/**
 * Turn rich-text input into AST documents through the document model.
 *
 * Notes only carry `alter-doc/1` content, so creating a document is two steps:
 * the Host creates the empty AST note, then the client fills it with Markdown
 * through the document model (`doc.generate`). Rich-text editor output is
 * converted to Markdown first; the note body is never written through
 * `space.saveNode`.
 *
 * @module @alter/ui-space/thought-conversion
 */
import type { SpaceNode, SpaceService, Thought } from '@alter/protocol';
import { documentModelOf } from './document-model';
import { htmlToMarkdown } from './utils/markdown';

/** Raised when the host did not attach the document-model client. */
export class DocumentModelUnavailableError extends Error {
  constructor() {
    super('文档模型客户端未装配，无法转换文档');
    this.name = 'DocumentModelUnavailableError';
  }
}

/**
 * Create an empty AST note and fill it with the converted rich-text content.
 * @returns the created note.
 */
export async function createDocumentFromHtml(
  service: SpaceService,
  input: { spaceId: string; html: string },
): Promise<SpaceNode> {
  const client = documentModelOf(service);
  if (client === undefined) throw new DocumentModelUnavailableError();
  const node = await service.createNode({
    spaceId: input.spaceId,
    kind: 'note',
  });
  await client.generate({
    docId: node.id,
    markdown: htmlToMarkdown(input.html),
  });
  return node;
}

/**
 * Convert one thought into an AST document and fill it with its content.
 * @returns the converted note.
 */
export async function convertThoughtToDocument(
  service: SpaceService,
  thought: Thought,
): Promise<SpaceNode> {
  const client = documentModelOf(service);
  if (client === undefined) throw new DocumentModelUnavailableError();
  const result = await service.convertThought(thought.id);
  await client.generate({
    docId: result.node.id,
    markdown: htmlToMarkdown(thought.content),
  });
  return result.node;
}
