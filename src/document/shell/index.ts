/**
 * Public surface of the AST document shell (chrome around the editor).
 *
 * @module @alter-dsh/space/document/shell
 */
export {
  DocumentBreadcrumbs,
  type DocumentBreadcrumbsProps,
} from './DocumentBreadcrumbs';
export { DocumentMenu, type DocumentMenuProps } from './DocumentMenu';
export { DocumentMeta, type DocumentMetaProps } from './DocumentMeta';
export { DocumentTitle, type DocumentTitleProps } from './DocumentTitle';
export { WorkbenchEntry, type WorkbenchEntryProps } from './WorkbenchEntry';
export {
  copyDocumentLink,
  createChildDocument,
  documentDeepLink,
  downloadMarkdownFile,
  exportMarkdownContent,
  markdownFileName,
  readDocumentMarkdown,
  type ChildDocumentContext,
  type DocumentMarkdown,
} from './actions';
