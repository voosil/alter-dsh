/**
 * Document builders and the AST probe used by operation/editor tests.
 *
 * Host and client each need a valid `alter-doc/1` tree. Tests import the shape
 * from here so the fixtures and the probe cannot disagree about what a valid
 * document looks like. Types come from the Host document model, which is the
 * canonical definition (`src/` only carries the adapter-facing subset).
 */
import type {
  AlterDoc,
  BlockNode,
  InlineNode,
} from '../../host/document/editors/legacy/types.js';

type Attrs = Record<string, unknown>;

/** A minimal valid `alter-doc/1` document envelope. */
export function emptyDoc(revision = 1): AlterDoc {
  return { format: 'alter-doc/1', schemaVersion: 1, revision, blocks: [] };
}

/**
 * One block node with a stable id.
 * @param id - block id (`blk_…`).
 * @param type - v0 block type.
 * @param rest - `attrs`, `content` and `children` overrides.
 */
export function block(
  id: string,
  type: string,
  rest: { attrs?: Attrs; content?: InlineNode[]; children?: BlockNode[] } = {},
): BlockNode {
  return {
    id,
    type,
    attrs: (rest.attrs ?? {}) as BlockNode['attrs'],
    ...(rest.content === undefined ? {} : { content: rest.content }),
    ...(rest.children === undefined ? {} : { children: rest.children }),
  };
}

/** One paragraph block whose inline text is `text`. */
export function paragraph(id: string, text: string): BlockNode {
  return block(id, 'paragraph', {
    content: [{ type: 'text', text }] as unknown as InlineNode[],
  });
}

/** Whether `value` looks like an `alter-doc/1` envelope (shape only). */
export function isValidDocument(value: unknown): boolean {
  const record = value as { format?: unknown; schemaVersion?: unknown; blocks?: unknown };
  return (
    record.format === 'alter-doc/1' &&
    record.schemaVersion === 1 &&
    Array.isArray(record.blocks)
  );
}