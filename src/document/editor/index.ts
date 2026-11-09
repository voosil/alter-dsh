/**
 * Public surface of the AST document editor.
 *
 * `AlterDocumentView` (integrated by the view owner) only needs the component
 * and its props; the pure helpers are exported for tests and future callers.
 *
 * @module @alter-dsh/space/document/editor
 */
export {
  AlterTiptapEditor,
  type AlterTiptapEditorProps,
} from './AlterTiptapEditor';
export {
  astToTiptap,
  blockToTiptap,
  newBlockId,
  tiptapToBlocks,
} from './mapping';
export {
  DocumentDiffError,
  MAX_DIFF_OPERATIONS,
  computeOperations,
} from './operations';
export {
  BLOCK_ID_ATTRIBUTE,
  BLOCK_NODE_TYPES,
  editorExtensions,
} from './schema';
