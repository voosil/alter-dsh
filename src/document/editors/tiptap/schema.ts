/**
 * ProseMirror schema derived from the client node manifest.
 *
 * A kernel must not hand-write its node schema: the manifest is the projection
 * of the Host registry, so deriving the schema keeps one source of truth and
 * makes a registry change a test failure instead of a silently missing node
 * (design: `docs/designs/editor-kernel-replacement.md` §3).
 *
 * Mapping rules:
 * - `contentModel: 'inline'` -> `content: 'inline*'` (a block that holds text);
 * - `contentModel: 'blocks'` -> `'<children>+'` from the registry declaration,
 *   or `'block*'` when the registry declares no restriction;
 * - `contentModel: 'table'` -> `'tableRow+'` (rows contain `tableCell+`);
 * - `contentModel: 'none'` -> an atom leaf block;
 * - every node carries its stable `id` attribute (the AST block id) so a
 *   capture can map ProseMirror positions back to comment anchors.
 *
 * Node type names equal AST node type names, so an AST block and a ProseMirror
 * node are the same concept in both directions.
 *
 * @module @alter-dsh/space/document/editors/tiptap/schema
 */
import {
  Schema,
  type DOMOutputSpec,
  type Mark as PmMark,
  type MarkSpec,
  type NodeSpec,
  type Schema as SchemaType,
} from '@tiptap/pm/model';
import {
  MARK_ORDER,
  NODE_MANIFEST,
  type NodeManifestEntry,
} from '../../schema-manifest';

/** ProseMirror group every block-level AST node belongs to. */
export const BLOCK_GROUP = 'block';

/**
 * Root-level group: every block except table parts.
 *
 * `tableRow`/`tableCell` must stay reachable by `block*` inside containers
 * (ProseMirror rejects a `block*` that cannot cover every member), but they must
 * never be allowed directly at the document root or as a top-level editor node.
 */
export const ROOT_GROUP = 'rootBlock';

/** Node types that are table parts and never appear at the root. */
const TABLE_PART = new Set(['tableRow', 'tableCell']);

/** The `doc` root content expression: one or more root blocks. */
const DOC_CONTENT = `${ROOT_GROUP}+`;

/**
 * Attribute specs for one node: the stable AST id plus the registry attrs.
 *
 * Every attribute gets a default. ProseMirror treats a node with a required
 * attribute that has no default as "non-generatable" and rejects the whole
 * schema when such a node appears in a required position (`doc` contains
 * `heading`, `image` is a block, ...). The Host still validates requiredness
 * on write; here a missing value just starts as `null` and the editor fills it
 * in (or the save reports the schema error).
 */
function attrsFor(entry: NodeManifestEntry): NodeSpec['attrs'] {
  const attrs: NonNullable<NodeSpec['attrs']> = { id: { default: null } };
  for (const [key, spec] of Object.entries(entry.attrs)) {
    attrs[key] = { default: spec.default ?? null };
  }
  return attrs;
}

/**
 * Content expression of a container node.
 *
 * A container that declares children accepts exactly those children. One that
 * declares none accepts any block. That is valid for `listItem` and for
 * `blockquote`/`callout` alike: `block*` resolves to members of the `block`
 * group, and every generic container is such a member.
 */
function containerContent(entry: NodeManifestEntry): string {
  const children = entry.children ?? [];
  if (children.length === 0) return 'block*';
  return children.map((child) => `${child}+`).join(' ');
}

/** ProseMirror node spec for one manifest entry. */
export function nodeSpecOf(entry: NodeManifestEntry): NodeSpec {
  const spec: NodeSpec = {
    group: TABLE_PART.has(entry.type)
      ? BLOCK_GROUP
      : `${BLOCK_GROUP} ${ROOT_GROUP}`,
    attrs: attrsFor(entry),
  };
  switch (entry.contentModel) {
    case 'inline':
      spec.content = 'inline*';
      break;
    case 'blocks':
      spec.content = containerContent(entry);
      break;
    case 'table':
      spec.content = containerContent(entry);
      break;
    case 'none':
      spec.atom = true;
      spec.selectable = true;
      break;
  }
  // A node that allows no marks must reject them outright (code blocks).
  if (entry.marks.length === 0) spec.marks = '';
  return spec;
}

/** Mark specs for the AST mark set (link carries its `href`). */
function markSpecs(): Record<string, MarkSpec> {
  return {
    bold: { toDOM: () => ['strong', 0] },
    italic: { toDOM: () => ['em', 0] },
    underline: { toDOM: () => ['u', 0] },
    strike: { toDOM: () => ['s', 0] },
    code: { toDOM: () => ['code', 0], excludes: '_' },
    highlight: { toDOM: () => ['mark', 0] },
    link: {
      attrs: { href: {} },
      inclusive: false,
      toDOM: (mark: PmMark): DOMOutputSpec => [
        'a',
        { href: String(mark.attrs['href'] ?? '') },
        0,
      ],
    },
  };
}

/**
 * Build the ProseMirror schema for every manifest node plus the AST marks.
 *
 * Deterministic per manifest version; the kernel builds it once
 * ({@link editorSchema}). `toDOM` here is a placeholder: the kernel overlays
 * the frozen document CSS classes on top of these specs.
 */
export function buildEditorSchema(): SchemaType {
  const nodes: Record<string, NodeSpec> = {
    doc: { content: DOC_CONTENT },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
  };
  for (const entry of Object.values(NODE_MANIFEST)) {
    nodes[entry.type] = nodeSpecOf(entry);
  }
  const allMarks = markSpecs();
  const marks: Record<string, MarkSpec> = {};
  for (const name of MARK_ORDER) {
    const spec = allMarks[name];
    if (spec === undefined)
      throw new Error(`mark ${name} has no ProseMirror spec`);
    marks[name] = spec;
  }
  return new Schema({ nodes, marks });
}

/**
 * Shared schema instance for the Tiptap kernel.
 *
 * Built lazily: a schema constant evaluated at import time turns a schema bug
 * into an import-time crash for every consumer (tests and kernel alike), which
 * hides the real error behind a module-load failure.
 */
let sharedSchema: SchemaType | undefined;

/** The kernel schema (built once on first use). */
export function getEditorSchema(): SchemaType {
  sharedSchema ??= buildEditorSchema();
  return sharedSchema;
}

/** Attribute names the schema carries for one node type (`id` first). */
export function schemaAttrNames(type: string): string[] {
  return Object.keys(getEditorSchema().nodes[type]?.spec.attrs ?? {});
}