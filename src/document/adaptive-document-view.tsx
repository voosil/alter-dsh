import type { SpaceNode } from '@alter/protocol';
import { DocumentView as LegacyDocumentView } from '../../vendor/ui-space/src/views/DocumentView';
import { AlterDocumentView } from './AlterDocumentView';

/**
 * Build-time replacement for the vendored `DocumentView`.
 *
 * Legacy HTML notes keep the original editor and all of its comment/history
 * behavior. AST-backed notes (`contentFormat: 'alter-doc/1'`) render through
 * the structured, read-only document view until the Tiptap editor lands.
 */
function isAlterDocNode(node: SpaceNode): boolean {
  const format = (node as { contentFormat?: unknown }).contentFormat;
  if (format === 'alter-doc/1') return true;
  const content = typeof node.content === 'string' ? node.content.trimStart() : '';
  if (!content.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { format?: unknown }).format === 'alter-doc/1'
    );
  } catch {
    return false;
  }
}

export function DocumentView({
  node,
  embedded,
}: {
  node: SpaceNode;
  embedded?: boolean;
}) {
  if (isAlterDocNode(node)) return <AlterDocumentView node={node} />;
  return (
    <LegacyDocumentView
      node={node}
      {...(embedded === undefined ? {} : { embedded })}
    />
  );
}
