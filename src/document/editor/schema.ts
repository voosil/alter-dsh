/**
 * Tiptap schema for the Alter document editor.
 *
 * The schema mirrors the Host v0 node registry
 * (`host/document/schema.ts` / `docs/specs/document-model-v0.md` §6.1):
 * - StarterKit supplies paragraph/heading/codeBlock/blockquote/lists/
 *   horizontalRule/hardBreak plus the inline marks;
 * - Link, Underline, Highlight, TaskList/TaskItem and the table extensions add
 *   the remaining v0 content;
 * - a global `blockId` attribute is attached to every block type (including
 *   `tableRow`/`tableCell`/`tableHeader`) so the AST ids survive editing and
 *   the diff can address blocks;
 * - `alterCallout` (container), `alterImage`, `alterMindmap`,
 *   `alterComponent`, `alterBookmark` and `alterDocLink` (atoms) are the
 *   custom blocks. They render safe `data-*` placeholder markup and a React
 *   node view; object payloads never enter the editor.
 *
 * StarterKit already bundles Link and Underline; those are disabled there and
 * re-registered with explicit options so the schema stays intentional.
 *
 * @module @alter-dsh/space/document/editor/schema
 */
import {
  Extension,
  Node,
  mergeAttributes,
  type Attribute,
  type Extensions,
} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Underline } from '@tiptap/extension-underline';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@tiptap/extension-table';
import { ReactNodeViewRenderer } from '@tiptap/react';
import {
  AlterBookmarkNodeView,
  AlterCalloutView,
  AlterComponentNodeView,
  AlterDocLinkNodeView,
  AlterImageNodeView,
  AlterMindmapNodeView,
} from './node-views';

/** Name of the global node attribute that carries the AST block id. */
export const BLOCK_ID_ATTRIBUTE = 'blockId';

/** Every block node type that carries a `blockId` attribute. */
export const BLOCK_NODE_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'taskItem',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'alterCallout',
  'alterImage',
  'alterMindmap',
  'alterComponent',
  'alterBookmark',
  'alterDocLink',
] as const;

/** `altText` → `alt-text` (data attribute names are kebab-case). */
function kebab(key: string): string {
  return key.replaceAll(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * A string node attribute rendered/parsed as `data-<kebab>`.
 * `fallback` is used by `renderHTML` when the value is not a string.
 */
function textAttribute(key: string, fallback?: string): Attribute {
  return {
    default: fallback ?? null,
    parseHTML: (element: HTMLElement) => element.getAttribute(`data-${kebab(key)}`),
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[key];
      return typeof value === 'string' && value !== ''
        ? { [`data-${kebab(key)}`]: value }
        : {};
    },
  };
}

/** A nullable boolean attribute rendered as `data-<kebab>` true/false. */
function booleanAttribute(key: string): Attribute {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute(`data-${kebab(key)}`);
      return value === 'true' ? true : value === 'false' ? false : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[key];
      return typeof value === 'boolean'
        ? { [`data-${kebab(key)}`]: String(value) }
        : {};
    },
  };
}

/** Read a string node attribute without trusting its runtime type. */
function stringAttr(
  attrs: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = attrs[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Global `blockId` attribute: `data-block-id` in HTML, the AST id in JSON.
 * It is a global attribute (instead of one extension per node) so built-in
 * StarterKit nodes can carry ids without wrapping every node type.
 */
const BlockIdAttribute = Extension.create({
  name: 'alterBlockId',
  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_NODE_TYPES],
        attributes: {
          [BLOCK_ID_ATTRIBUTE]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute('data-block-id'),
            renderHTML: (attributes: Record<string, unknown>) => {
              const id = attributes[BLOCK_ID_ATTRIBUTE];
              return typeof id === 'string' && id !== ''
                ? { 'data-block-id': id }
                : {};
            },
          },
        },
      },
    ];
  },
});

/** `alterCallout`: editable container with tone/title/icon/collapsed attrs. */
const AlterCallout = Node.create({
  name: 'alterCallout',
  group: 'block',
  content: 'block+',
  defining: true,
  selectable: true,
  addAttributes() {
    return {
      tone: textAttribute('tone', 'info'),
      title: textAttribute('title'),
      icon: textAttribute('icon'),
      collapsed: booleanAttribute('collapsed'),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-alter-callout]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as Record<string, unknown>;
    const tone = stringAttr(attrs, 'tone') ?? 'info';
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'alter-callout',
        'data-alter-callout': '',
        'data-tone': tone,
      }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlterCalloutView);
  },
});

/** `alterImage`: atom placeholder for an asset reference. */
const AlterImage = Node.create({
  name: 'alterImage',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      assetId: textAttribute('assetId'),
      alt: textAttribute('alt'),
      caption: textAttribute('caption'),
      width: textAttribute('width'),
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-alter-image]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as Record<string, unknown>;
    const alt = stringAttr(attrs, 'alt');
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        class: 'alter-image',
        'data-alter-image': '',
      }),
      ['div', { class: 'alter-image-placeholder' }, alt ?? '图片'],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlterImageNodeView);
  },
});

/** `alterMindmap`: atom placeholder for a structured mindmap object. */
const AlterMindmap = Node.create({
  name: 'alterMindmap',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      objectId: textAttribute('objectId'),
      caption: textAttribute('caption'),
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-alter-mindmap]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as Record<string, unknown>;
    const caption = stringAttr(attrs, 'caption');
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        class: 'alter-object',
        'data-alter-mindmap': '',
      }),
      ['div', { class: 'alter-object-title' }, caption ?? '思维导图'],
      ['div', { class: 'alter-object-meta' }, stringAttr(attrs, 'objectId') ?? ''],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlterMindmapNodeView);
  },
});

/** `alterComponent`: atom placeholder for a declarative component object. */
const AlterComponent = Node.create({
  name: 'alterComponent',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      objectId: textAttribute('objectId'),
      title: textAttribute('title'),
      description: textAttribute('description'),
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-alter-component]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as Record<string, unknown>;
    const title = stringAttr(attrs, 'title');
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        class: 'alter-object',
        'data-alter-component': '',
      }),
      ['div', { class: 'alter-object-title' }, title ?? '交互组件'],
      ['div', { class: 'alter-object-meta' }, stringAttr(attrs, 'objectId') ?? ''],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlterComponentNodeView);
  },
});

/** `alterBookmark`: atom card for one external web link. */
const AlterBookmark = Node.create({
  name: 'alterBookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      url: textAttribute('url'),
      title: textAttribute('title'),
      description: textAttribute('description'),
      icon: textAttribute('icon'),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-alter-bookmark]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as Record<string, unknown>;
    const title =
      stringAttr(attrs, 'title') ?? stringAttr(attrs, 'url') ?? '网页链接';
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'alter-link-card',
        'data-alter-bookmark': '',
      }),
      ['span', { class: 'alter-link-card-title' }, title],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlterBookmarkNodeView);
  },
});

/** `alterDocLink`: atom card for one internal document reference. */
const AlterDocLink = Node.create({
  name: 'alterDocLink',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      docId: textAttribute('docId'),
      title: textAttribute('title'),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-alter-doc-link]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as Record<string, unknown>;
    const title =
      stringAttr(attrs, 'title') ?? stringAttr(attrs, 'docId') ?? '文档内链';
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'alter-link-card',
        'data-alter-doc-link': '',
      }),
      ['span', { class: 'alter-link-card-title' }, title],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AlterDocLinkNodeView);
  },
});

/**
 * Full editor extension list. Markdown input rules from StarterKit are kept
 * (users type Markdown), but autolink/trailing-node behaviour is disabled so
 * the editor never silently adds content on its own.
 */
export const editorExtensions: Extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    link: false,
    underline: false,
    trailingNode: false,
  }),
  Link.configure({
    openOnClick: false,
    autolink: false,
    linkOnPaste: false,
    HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
  }),
  Underline,
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false, allowTableNodeSelection: true }),
  TableRow,
  TableCell,
  TableHeader,
  BlockIdAttribute,
  AlterCallout,
  AlterImage,
  AlterMindmap,
  AlterComponent,
  AlterBookmark,
  AlterDocLink,
];
