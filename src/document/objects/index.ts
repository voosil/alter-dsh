/**
 * Public surface of the structured document objects module.
 *
 * @module @alter-dsh/space/document/objects
 */
export {
  MINDMAP_DEFAULT_CHILD_TEXT,
  MINDMAP_DEFAULT_ROOT_TEXT,
  MINDMAP_EDIT_EVENT,
  MINDMAP_MAX_NODES,
  MINDMAP_MAX_TEXT_LENGTH,
  addMindmapChild,
  cloneMindmapPayload,
  countMindmapNodes,
  createMindmapPayload,
  deleteMindmapNode,
  findMindmapNode,
  flattenMindmap,
  renameMindmapNode,
  validateMindmapPayload,
  type MindmapEditRequest,
  type MindmapNode,
  type MindmapPayload,
  type MindmapValidation,
} from './mindmap';
export { MindmapEditor, type MindmapEditorProps } from './MindmapEditor';
export {
  PENDING_OBJECT_ID,
  buildDeleteBlockOperation,
  buildPendingObjectInsertOperation,
  buildUpdateObjectOperation,
  type PendingObjectBlockKind,
  type PendingObjectInsertInput,
} from './operations';
