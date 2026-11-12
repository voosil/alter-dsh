/**
 * Tiptap node/mark extensions derived from the client manifest.
 *
 * The visual contract is the frozen `Editor.module.css`: it styles plain
 * elements (`p`, `h1`, `pre > code`, `ul`, `blockquote`, `table`, `img`) and
 * `data-*` attributes (`data-todo`, `data-divider`, `data-file`, …), so the
 * kernel renders exactly those shapes and reuses the stylesheet unchanged.
 *
 * No node here re-implements editor behavior: input rules, keymaps, selection
 * handling and undo come from Tiptap/ProseMirror extensions layered on in
 * `editors/tiptap/editor.ts`.
 *
 * @module @alter-dsh/space/document/editors/tiptap/nodes
 */
import { InputRule, Mark, Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import type { Mark as PmMark } from '@tiptap/pm/model';
import {
  MARK_ORDER,
  NODE_MANIFEST,
  type NodeManifestEntry,
} from '../../schema-manifest';

/** Node types Tiptap provides natively (paragraph, heading, lists, blockquote, code). */
const NATIVE = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
]);

/**
 * A divider renders as the frozen stylesheet expects: a wrapper carrying
 * `data-divider` around an `<hr>` (`.surface [data-divider] hr`).
 *
 * The input rule turns a line holding only `---` into a divider immediately, as
 * the frozen editor does — no Enter required — and leaves a paragraph below so
 * typing can continue.
 */
const Divider = Node.create({
  name: 'divider',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return attributesOf(NODE_MANIFEST['divider']!);
  },
  parseHTML() {
    return [{ tag: 'div[data-divider]' }, { tag: 'hr' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-block-type': 'divider',
        'data-divider': '',
      }),
      ['hr'],
    ];
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^---$/,
        handler: ({ state, range, match }) => {
          // Only convert when the line is exactly `---`.
          if (match[0].trim() !== '---') return;
          const { $from } = state.selection;
          // Skip code blocks, where `---` is legitimate content (frontmatter).
          if ($from.parent.type.name === 'codeBlock') return;
          // Only a top-level line converts; inside a list it stays text.
          if ($from.depth > 1) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ id: null }),
          );
        },
      }),
    ];
  },
});

/** Node types rendered as atomic cards/placeholders (no in-place editing). */
const ATOM_TYPES = new Set([
  'image',
  'file',
  'bookmark',
  'docLink',
  'mindmap',
  'component',
]);

/** DOM tag the frozen stylesheet expects for one atom node type. */
const TAG_OF: Readonly<Record<string, string>> = {
  divider: 'div',
  image: 'img',
  file: 'div',
  bookmark: 'div',
  docLink: 'a',
  mindmap: 'div',
  component: 'div',
};

/**
 * The stable block id rendered as `data-block-id`.
 *
 * The frozen stylesheet and the comment rail both locate blocks through
 * `[data-block-id]`, so a node that forgets it silently loses its anchor.
 */
const BLOCK_ID_ATTRIBUTE = {
  default: null,
  parseHTML: (element: HTMLElement): string | null =>
    element.getAttribute('data-block-id'),
  renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
    const id = attrs['id'];
    return typeof id === 'string' && id !== ''
      ? { 'data-block-id': id }
      : {};
  },
};

/** Registry attributes plus the stable block id, all with a default. */
function attributesOf(entry: NodeManifestEntry): Record<string, unknown> {
  const attrs: Record<string, unknown> = { id: BLOCK_ID_ATTRIBUTE };
  for (const [key, spec] of Object.entries(entry.attrs)) {
    attrs[key] = { default: spec.default ?? null };
  }
  return attrs;
}

/** `data-*` attributes one atom node renders from its registry attrs. */
function dataAttributes(
  name: string,
  attrs: Record<string, unknown>,
  documentAssetUrl: (assetId: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof attrs['id'] === 'string' && attrs['id'] !== '') {
    out['data-block-id'] = attrs['id'];
  }
  out['data-block-type'] = name;
  const assetId = typeof attrs['assetId'] === 'string' ? attrs['assetId'] : '';
  switch (name) {
    case 'divider':
      out['data-divider'] = '';
      break;
    case 'image': {
      const src =
        typeof attrs['src'] === 'string' && attrs['src'] !== ''
          ? attrs['src']
          : assetId === ''
            ? ''
            : documentAssetUrl(assetId);
      out['src'] = src;
      out['alt'] = String(attrs['alt'] ?? '');
      out['data-asset-id'] = assetId;
      break;
    }
    case 'file':
      out['data-file'] = String(attrs['name'] ?? '');
      out['data-file-icon'] = '';
      out['data-mime'] = String(attrs['mime'] ?? '');
      out['data-bytes'] = String(attrs['bytes'] ?? 0);
      out['data-asset-id'] = assetId;
      break;
    case 'bookmark':
      out['data-link-card'] = '';
      break;
    case 'docLink':
      out['data-doc-link'] = '';
      out['data-doc-id'] = String(attrs['docId'] ?? '');
      out['href'] = `#/doc/${String(attrs['docId'] ?? '')}`;
      break;
    case 'mindmap':
    case 'component':
      out['data-object-card'] = name;
      out['data-object-id'] = String(attrs['objectId'] ?? '');
      break;
  }
  return out;
}

/** One atomic card/placeholder node. */
function atomNode(
  entry: NodeManifestEntry,
  documentAssetUrl: (assetId: string) => string,
): AnyExtension {
  const tag = TAG_OF[entry.type] ?? 'div';
  return Node.create({
    name: entry.type,
    group: 'block',
    atom: true,
    selectable: true,
    addAttributes() {
      return attributesOf(entry);
    },
    parseHTML() {
      return [{ tag: `${tag}[data-block-type="${entry.type}"]` }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return [
        tag,
        mergeAttributes(
          HTMLAttributes,
          dataAttributes(entry.type, node.attrs, documentAssetUrl),
        ),
      ];
    },
  });
}

/** Task list wrapper rendered as `ul[data-task-list]`. */
const TaskList = Node.create({
  name: 'taskList',
  group: 'block',
  content: 'listItem+',
  parseHTML() {
    return [{ tag: 'ul[data-task-list]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes, { 'data-task-list': '' }), 0];
  },
});

/**
 * Callout container: its children are real blocks, unlike the atom cards.
 *
 * The frozen UI has no callout visual; it renders as a neutral container so
 * content is never hidden (design §9: placeholders, no invented styling).
 */
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block*',
  defining: true,
  addAttributes() {
    return attributesOf(NODE_MANIFEST['callout']!);
  },
  parseHTML() {
    return [{ tag: 'div[data-block-type="callout"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const title = node.attrs['title'];
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-block-type': 'callout',
        'data-callout': String(node.attrs['tone'] ?? 'info'),
        ...(typeof title === 'string' && title !== ''
          ? { 'data-callout-title': title }
          : {}),
      }),
      0,
    ];
  },
});

/** DOM tag for one AST mark, matching the frozen stylesheet. */
const MARK_TAG: Readonly<Record<string, string>> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
  highlight: 'mark',
  link: 'a',
};

/**
 * One inline mark whose DOM tag the frozen stylesheet already styles.
 *
 * Tiptap builds the ProseMirror mark spec from `addAttributes()`, so the link's
 * `href` must be declared there — setting `attrs` directly is ignored and the
 * attribute never reaches the document (it would silently render `href=""`).
 */
function markExtension(name: (typeof MARK_ORDER)[number]): AnyExtension {
  const tag = MARK_TAG[name]!;
  const isLink = name === 'link';
  return Mark.create({
    name,
    ...(name === 'code' ? { excludes: '_' } : {}),
    ...(isLink
      ? {
          inclusive: false,
          addAttributes() {
            return {
              href: {
                default: null,
                parseHTML: (element: HTMLElement): string | null =>
                  element.getAttribute('href'),
                renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
                  const href = attrs['href'];
                  return typeof href === 'string' && href !== '' ? { href } : {};
                },
              },
            };
          },
        }
      : {}),
    parseHTML() {
      return [{ tag: isLink ? 'a[href]' : tag }];
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes), 0];
    },
  });
}

/**
 * Every extension this kernel adds to the native Tiptap set.
 *
 * @param documentAssetUrl maps a stored `asset_…` id to a servable URL.
 */
export function manifestExtensions(
  documentAssetUrl: (assetId: string) => string,
): AnyExtension[] {
  const atoms = Object.values(NODE_MANIFEST)
    .filter((entry) => ATOM_TYPES.has(entry.type))
    .map((entry) => atomNode(entry, documentAssetUrl));
  return [
    Divider,
    ...atoms,
    TaskList,
    Callout,
    ...MARK_ORDER.map((name) => markExtension(name)),
  ];
}

/** Node names this module owns (the kernel asserts coverage in tests). */
export const MANIFEST_NODE_NAMES: readonly string[] = [
  'divider',
  ...ATOM_TYPES,
  'taskList',
  'callout',
  // Table parts come from the Tiptap table extensions; listed here so the
  // coverage check can prove every registry node has exactly one extension.
  'table',
  'tableRow',
  'tableCell',
];

/** Native node names the kernel relies on Tiptap for. */
export const NATIVE_NODE_NAMES: readonly string[] = [...NATIVE];

/** Marks the kernel declares (must equal the AST mark order). */
export const MANIFEST_MARK_NAMES: readonly string[] = MARK_ORDER;

/** Read the link target of one ProseMirror mark. */
export function linkHrefOf(mark: PmMark): string | undefined {
  const href = mark.attrs['href'];
  return typeof href === 'string' && href !== '' ? href : undefined;
}
