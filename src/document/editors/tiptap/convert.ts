/**
 * Lossless `alter-doc/1` <-> ProseMirror document mapping.
 *
 * This replaces the HTML round-trip the legacy kernel needs: an AST block and
 * a ProseMirror node are the same tree, so conversion is a structural walk with
 * no intermediate string format and no parsing heuristics.
 *
 * Both directions are **total**: input the schema cannot represent is reported
 * through `warnings` instead of being silently dropped, matching the adapter
 * rule that "unknown markup degrades visibly, never disappears".
 *
 * @module @alter-dsh/space/document/editors/tiptap/convert
 */
import {
  Fragment,
  type Mark as PmMark,
  type Node as PmNode,
  type Schema as SchemaType,
} from '@tiptap/pm/model';
import type { BlockNode, InlineNode, Mark, JsonValue } from '../../types';
import { nodeManifestEntry } from '../../schema-manifest';
import { getEditorSchema } from './schema';

/** Result of one conversion direction. */
export interface ConversionResult<T> {
  value: T;
  /** Content the target format could not represent, in human-readable form. */
  warnings: string[];
}

/**
 * Canonical AST form: empty `content`/`children` arrays are omitted, matching
 * what the Host stores. Ids and order are preserved.
 */
export function normalizeBlocks(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.map((node) => {
    const out: BlockNode = {
      id: node.id,
      type: node.type,
      attrs: normalizeAttrs(node.attrs),
    };
    if (node.content !== undefined && node.content.length > 0) {
      out.content = node.content;
    }
    if (node.children !== undefined && node.children.length > 0) {
      out.children = normalizeBlocks(node.children);
    }
    return out;
  });
}

/** Drop `undefined`/`null` attribute values (the registry default applies). */
function normalizeAttrs(attrs: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/** ProseMirror mark for one AST mark (undefined when the schema lacks it). */
function pmMarkFor(mark: Mark, schema: SchemaType): PmMark | undefined {
  const type = schema.marks[mark.type];
  if (type === undefined) return undefined;
  if (mark.type === 'link') {
    const href = mark.attrs?.href;
    if (typeof href !== 'string' || href === '') return undefined;
    return type.create({ href });
  }
  return type.create();
}

/**
 * Inline nodes of one AST block -> ProseMirror inline fragment.
 *
 * `allowedMarks` is the set the owning node type permits (empty for code
 * blocks). ProseMirror's `marks: ''` only restricts *editing*; `create()`
 * happily stores a mark the schema forbids, so dropping them has to happen
 * here or an illegal mark would reach the Host and fail schema validation.
 */
function inlineContent(
  content: readonly InlineNode[],
  blockType: string,
  allowedMarks: readonly string[],
  schema: SchemaType,
  warnings: string[],
): PmNode[] {
  const nodes: PmNode[] = [];
  for (const node of content) {
    if (node.type === 'hardBreak') {
      nodes.push(schema.nodes['hardBreak']!.create());
      continue;
    }
    if (node.text === '') continue;
    const marks: PmMark[] = [];
    for (const mark of node.marks ?? []) {
      if (!allowedMarks.includes(mark.type)) {
        warnings.push(
          `${blockType}: 行内标记 ${mark.type} 不被该节点允许，已省略`,
        );
        continue;
      }
      const pmMark = pmMarkFor(mark, schema);
      if (pmMark === undefined) {
        warnings.push(
          `${blockType}: 行内标记 ${mark.type} 在编辑器 schema 中不可用，已省略`,
        );
        continue;
      }
      marks.push(pmMark);
    }
    nodes.push(schema.text(node.text, marks));
  }
  return nodes;
}

/** Convert AST blocks into one ProseMirror document. */
export function blocksToPmDoc(
  blocks: readonly BlockNode[],
  schema: SchemaType = getEditorSchema(),
): ConversionResult<PmNode> {
  const warnings: string[] = [];
  const nodes: PmNode[] = [];
  for (const block of blocks) {
    const converted = blockToPmNode(block, schema, warnings);
    if (converted !== undefined) nodes.push(converted);
  }
  // The doc schema requires at least one block; an empty document is a single
  // empty paragraph, which is also what a fresh document looks like.
  if (nodes.length === 0) nodes.push(emptyParagraph(schema));
  return {
    value: schema.nodes['doc']!.create(null, nodes),
    warnings,
  };
}

/** One empty paragraph node (the canonical empty document body). */
export function emptyParagraph(schema: SchemaType = getEditorSchema()): PmNode {
  return schema.nodes['paragraph']!.create({ id: '' }, null, []);
}

/** Convert one AST block (recursively) into a ProseMirror node. */
function blockToPmNode(
  block: BlockNode,
  schema: SchemaType,
  warnings: string[],
): PmNode | undefined {
  const manifest = nodeManifestEntry(block.type);
  const type = schema.nodes[block.type];
  if (manifest === undefined || type === undefined) {
    warnings.push(`${block.id}: 未知节点类型 ${block.type}，已省略`);
    return undefined;
  }
  const attrs: Record<string, JsonValue> = { ...normalizeAttrs(block.attrs), id: block.id };
  // Keep only attributes the node spec declares (the Host rejects the rest,
  // and an editor-created node may carry leftovers from another type).
  for (const key of Object.keys(attrs)) {
    if (key !== 'id' && manifest.attrs[key] === undefined) {
      warnings.push(`${block.type}.${key}: 属性不在节点契约中，已省略`);
      delete attrs[key];
    }
  }

  if (manifest.contentModel === 'none') {
    return type.create(attrs);
  }
  if (manifest.contentModel === 'inline') {
    const inline = inlineContent(
      block.content ?? [],
      block.type,
      manifest.marks,
      schema,
      warnings,
    );
    // `Node.create(attrs, content, marks)`: content is the second argument.
    return type.create(attrs, Fragment.fromArray(inline));
  }
  const children: PmNode[] = [];
  for (const child of block.children ?? []) {
    const converted = blockToPmNode(child, schema, warnings);
    if (converted !== undefined) children.push(converted);
  }
  if (children.length === 0) {
    warnings.push(`${block.type}: 容器没有可表示的子节点，已省略`);
    return undefined;
  }
  return type.create(attrs, Fragment.fromArray(children));
}

/** Convert one ProseMirror document back into canonical AST blocks. */
export function pmDocToBlocks(
  doc: PmNode,
  schema: SchemaType = getEditorSchema(),
): ConversionResult<BlockNode[]> {
  void schema;
  const warnings: string[] = [];
  const blocks: BlockNode[] = [];
  doc.forEach((node) => {
    const block = pmNodeToBlock(node, warnings);
    if (block !== undefined) blocks.push(block);
  });
  return { value: normalizeBlocks(blocks), warnings };
}

/** Stable block id for an editor-created node that has none yet. */
let generatedId = 0;

/** Allocate one `blk_…` id (the Host only requires a unique string). */
export function allocateBlockId(): string {
  generatedId += 1;
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  const unique =
    cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `blk_${unique.replaceAll('-', '')}${generatedId}`;
}

/**
 * Remembered ids for editor-created nodes.
 *
 * A node the editor inserted has no `id` attr yet; allocating a fresh one on
 * every capture would rewrite the block id on each save and break comment
 * anchors. The id is remembered per ProseMirror node and survives until the
 * kernel stamps it into the node attrs (which it does on the first capture).
 */
const rememberedIds = new WeakMap<PmNode, string>();

/** Reset remembered ids and the counter between tests. */
export function resetBlockIdSequence(): void {
  generatedId = 0;
}

/** Convert one ProseMirror node into an AST block (recursively). */
function pmNodeToBlock(node: PmNode, warnings: string[]): BlockNode | undefined {
  const manifest = nodeManifestEntry(node.type.name);
  if (manifest === undefined) {
    warnings.push(`未知的编辑器节点 ${node.type.name}，已省略`);
    return undefined;
  }
  const rawId = node.attrs['id'];
  let id: string;
  if (typeof rawId === 'string' && rawId !== '') {
    id = rawId;
  } else {
    const remembered = rememberedIds.get(node);
    if (remembered !== undefined) {
      id = remembered;
    } else {
      id = allocateBlockId();
      rememberedIds.set(node, id);
    }
  }
  const attrs: Record<string, JsonValue> = {};
  for (const key of Object.keys(manifest.attrs)) {
    const value = node.attrs[key];
    if (value === undefined || value === null) continue;
    attrs[key] = value as JsonValue;
  }
  const block: BlockNode = { id, type: manifest.type, attrs };

  if (manifest.contentModel === 'inline') {
    const content: InlineNode[] = [];
    node.forEach((child) => {
      if (child.isText) {
        const text = child.text ?? '';
        if (text === '') return;
        const marks: Mark[] = [];
        let missing = 0;
        for (const mark of child.marks) {
          const converted = astMarkOf(mark);
          if (converted === undefined) {
            missing += 1;
            continue;
          }
          marks.push(converted);
        }
        if (missing > 0) {
          warnings.push(
            `${manifest.type}: ${missing} 个行内标记在 AST 中不可表示，已省略`,
          );
        }
        content.push(marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks });
        return;
      }
      if (child.type.name === 'hardBreak') {
        content.push({ type: 'hardBreak' });
        return;
      }
      warnings.push(`${manifest.type}: 行内节点 ${child.type.name} 不可表示，已省略`);
    });
    if (content.length > 0) block.content = content;
    return block;
  }

  if (manifest.contentModel === 'none') return block;

  const children: BlockNode[] = [];
  node.forEach((child) => {
    const converted = pmNodeToBlock(child, warnings);
    if (converted !== undefined) children.push(converted);
  });
  if (children.length > 0) block.children = children;
  return block;
}

/** AST mark for one ProseMirror mark (undefined when the AST lacks it). */
function astMarkOf(mark: PmMark): Mark | undefined {
  const name = mark.type.name;
  if (name === 'link') {
    const href = mark.attrs['href'];
    if (typeof href !== 'string' || href === '') return undefined;
    return { type: 'link', attrs: { href } };
  }
  const known: ReadonlySet<Mark['type']> = new Set([
    'bold',
    'italic',
    'underline',
    'strike',
    'code',
    'highlight',
  ]);
  return known.has(name as Mark['type']) ? { type: name as Mark['type'] } : undefined;
}

