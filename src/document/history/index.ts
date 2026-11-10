/**
 * Public surface of the AST version-history tab.
 *
 * @module @alter-dsh/space/document/history
 */
export { HistoryView, type HistoryViewProps } from './HistoryView';
export {
  BLOCK_DIFF_KIND_LABELS,
  DIFF_TEXT_MAX_CHARS,
  EMPTY_ALTER_DOC,
  MAX_DIFF_ENTRIES,
  attrLabel,
  blockExcerpt,
  blockText,
  blockTitle,
  blockTypeLabel,
  blockTypeName,
  changedAttrs,
  diffAlterDocs,
  documentsEquivalent,
  type BlockDiff,
  type BlockDiffEntry,
  type BlockDiffKind,
} from './diff';
export {
  describeRestoreError,
  formatVersionTime,
  readHistorySnapshot,
  readRestoredRevision,
  versionTitle,
  type HistorySnapshot,
} from './snapshot';
