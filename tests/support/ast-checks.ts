/**
 * Document-tree assertion shared by the seeded fuzz suites.
 */
import type { AlterDoc, BlockNode } from '../../host/document/editors/legacy/types.js';
import { validateAlterDoc } from '../../host/document/ast/schema.js';

/** Every block id in the tree, depth first. */
export function blockIds(doc: AlterDoc): string[] {
  const ids: string[] = [];
  const visit = (blocks: BlockNode[]): void => {
    for (const block of blocks) {
      ids.push(block.id);
      if (block.children !== undefined) visit(block.children);
    }
  };
  visit(doc.blocks);
  return ids;
}

/** Assert the tree validates and carries no duplicate ids. */
export function assertValidDocument(doc: AlterDoc, context: string): void {
  try {
    validateAlterDoc(doc);
  } catch (error) {
    throw new Error(
      `${context}: validateAlterDoc failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ids = blockIds(doc);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${context}: duplicate block ids after apply`);
  }
}