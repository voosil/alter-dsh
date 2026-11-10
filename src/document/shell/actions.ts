/**
 * Side effects behind the document shell menu: deep links, child documents,
 * Markdown export and archive state.
 *
 * Kept as plain functions (no React) so the view stays declarative and the
 * behaviours can be unit tested without rendering the whole document surface.
 *
 * @module @alter-dsh/space/document/shell/actions
 */
import type { SpaceNode, SpaceService } from '@alter/protocol';
import type { SpaceDocumentClient } from '../../space-client';
import { docPath } from '../../../vendor/ui-space/src/space-route';
import type { SpaceRouter } from '../../../vendor/ui-space/src/types';

/** Host read projection cap (`doc.read` maxChars); export asks for all of it. */
const MAX_EXPORT_CHARS = 40_000;

/** Full browser deep link of one document (hash route kept verbatim). */
export function documentDeepLink(spaceId: string, docId: string): string {
  const route = docPath(spaceId, docId);
  if (typeof window === 'undefined') return route;
  return `${window.location.origin}${window.location.pathname}${route}`;
}

/**
 * Copy the document deep link to the clipboard.
 * @returns whether the clipboard write succeeded.
 */
export async function copyDocumentLink(
  spaceId: string,
  docId: string,
): Promise<boolean> {
  const link = documentDeepLink(spaceId, docId);
  const clipboard = (
    globalThis as {
      navigator?: { clipboard?: { writeText?: unknown } };
    }
  ).navigator?.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function')
    return false;
  try {
    await (
      clipboard.writeText as (this: unknown, text: string) => Promise<void>
    ).call(clipboard, link);
    return true;
  } catch {
    return false;
  }
}

/** Collaborators of {@link createChildDocument}. */
export interface ChildDocumentContext {
  service: Pick<SpaceService, 'createNode'>;
  router: Pick<SpaceRouter, 'navigate'>;
  spaceId: string;
  parentId: string;
  /** Insert the new node into the Space app state, when available. */
  addNodeToState?: (node: SpaceNode) => void;
  /** Reload the space node list, when available. */
  refresh?: () => void;
}

/**
 * Create an empty child note under the current document and navigate to it.
 * @returns the created node.
 */
export async function createChildDocument(
  context: ChildDocumentContext,
): Promise<SpaceNode> {
  const child = await context.service.createNode({
    spaceId: context.spaceId,
    parentId: context.parentId,
    kind: 'note',
  });
  context.addNodeToState?.(child);
  context.refresh?.();
  context.router.navigate(docPath(context.spaceId, child.id));
  return child;
}

/** Markdown read from the document client for export. */
export interface DocumentMarkdown {
  markdown: string;
  /** True when the Host projection hit its character cap. */
  truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read the document's Markdown projection through `doc.read`.
 *
 * Block anchors are disabled so the downloaded file is plain Markdown rather
 * than the AI-facing projection, and the Host's largest projection budget is
 * requested so normal documents export in one round-trip.
 */
export async function readDocumentMarkdown(
  client: Pick<SpaceDocumentClient, 'read'>,
  docId: string,
): Promise<DocumentMarkdown> {
  const value = await client.read(docId, {
    anchors: false,
    maxChars: MAX_EXPORT_CHARS,
  });
  const record = asRecord(value);
  if (record === undefined || typeof record['markdown'] !== 'string') {
    throw new Error('服务端返回的 Markdown 无法识别');
  }
  return {
    markdown: record['markdown'],
    truncated: record['truncated'] === true,
  };
}

/** Download filename derived from the title (illegal characters replaced). */
export function markdownFileName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim();
  return `${safe || '无标题'}.md`;
}

/** Markdown file body: title heading followed by the document projection. */
export function exportMarkdownContent(title: string, markdown: string): string {
  const heading = title.trim() || '无标题';
  const body = markdown.replace(/\s+$/, '');
  return body === '' ? `# ${heading}\n` : `# ${heading}\n\n${body}\n`;
}

/** Trigger a browser download of the document as a `.md` file. */
export function downloadMarkdownFile(title: string, markdown: string): void {
  const blob = new Blob([exportMarkdownContent(title, markdown)], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = markdownFileName(title);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
