/**
 * v0 block-type registry and validation.
 *
 * This is the single source of truth for node capabilities, attribute rules,
 * markdown projection metadata and type transforms. Storage validation, the
 * Markdown projection, the operation engine and Agent tools all read from it.
 *
 * @module @alter-dsh/space/document/schema
 */
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  MAX_BLOCK_COUNT,
  MAX_BLOCK_DEPTH,
  MAX_DOCUMENT_BYTES,
  MAX_OPERATION_BATCH,
  isPlainObject,
  serializeAlterDoc,
  type AlterDoc,
  type BlockNode,
  type DocumentErrorCode,
  type InlineNode,
  type JsonValue,
  type Mark,
  type MarkType,
  type OperationName,
  type TextEdit,
} from './types.js';

/** Node capability tier (spec §11.3). */
export type NodeKind = 'content' | 'structured' | 'application';
/** Structural shape of a node's payload. */
export type ContentModel = 'inline' | 'blocks' | 'none' | 'table';

/** Attribute rule for one node type. */
export interface AttrSpec {
  type: 'string' | 'number' | 'boolean' | 'json' | 'assetRef' | 'objectRef';
  required?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  /** Maximum string length for `string` attributes. */
  maxLength?: number;
}

/** One node type definition. */
export interface NodeTypeDefinition {
  type: string;
  schemaVersion: number;
  kind: NodeKind;
  contentModel: ContentModel;
  attrs: Record<string, AttrSpec>;
  allowedMarks?: MarkType[];
  /** Restricts children when `contentModel === 'blocks'`; omit for any block. */
  allowedChildren?: string[];
  ai: {
    readable: boolean;
    writable: boolean;
    preview: 'markdown' | 'directive' | 'placeholder';
    ops: OperationName[];
    describe?: boolean;
  };
  markdown: {
    anchors: 'comment' | 'none';
    directive?: string;
  };
  render: { editor: string; readOnly: string };
  /** Types this block may become through `transform_block`. */
  transforms?: string[];
}

/** Marks every textblock may carry in v0. */
export const MARK_TYPES: readonly MarkType[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
];

const CONTENT_OPS: OperationName[] = [
  'replace_block',
  'update_text',
  'update_attrs',
  'move_block',
  'delete_block',
  'transform_block',
];
const CONTAINER_OPS: OperationName[] = [
  'replace_block',
  'update_attrs',
  'move_block',
  'delete_block',
  'transform_block',
];
const MEDIA_OPS: OperationName[] = [
  'replace_block',
  'update_attrs',
  'move_block',
  'delete_block',
];
const OBJECT_OPS: OperationName[] = [
  'update_object',
  'replace_block',
  'move_block',
  'delete_block',
];

function textNode(type: string): NodeTypeDefinition {
  return {
    type,
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'inline',
    attrs: {},
    allowedMarks: [...MARK_TYPES],
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: [...CONTENT_OPS],
    },
    markdown: { anchors: 'comment' },
    render: { editor: type, readOnly: 'text' },
  };
}

function containerNode(
  type: string,
  extra: Partial<NodeTypeDefinition> = {},
): NodeTypeDefinition {
  return {
    type,
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'blocks',
    attrs: {},
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: [...CONTAINER_OPS],
    },
    markdown: { anchors: 'comment' },
    render: { editor: type, readOnly: 'blocks' },
    ...extra,
  };
}

/** The v0 node-type registry, in display order. */
export const NODE_TYPES: Readonly<Record<string, NodeTypeDefinition>> = {
  paragraph: {
    ...textNode('paragraph'),
    transforms: ['heading', 'blockquote', 'codeBlock'],
  },
  heading: {
    ...textNode('heading'),
    attrs: { level: { type: 'number', required: true, enum: [1, 2, 3, 4, 5, 6] } },
    transforms: ['paragraph', 'blockquote'],
    allowedMarks: ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link'],
  },
  bulletList: containerNode('bulletList', {
    allowedChildren: ['listItem'],
    markdown: { anchors: 'comment' },
  }),
  orderedList: containerNode('orderedList', {
    attrs: { start: { type: 'number', default: 1 } },
    allowedChildren: ['listItem'],
  }),
  taskList: containerNode('taskList', {
    allowedChildren: ['listItem'],
  }),
  listItem: containerNode('listItem', {
    attrs: { checked: { type: 'boolean' } },
  }),
  blockquote: containerNode('blockquote', {
    transforms: ['paragraph'],
  }),
  codeBlock: {
    type: 'codeBlock',
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'inline',
    attrs: { lang: { type: 'string', maxLength: 32 } },
    // Code body is plain text; marks are not allowed inside a code block.
    allowedMarks: [],
    transforms: ['paragraph'],
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: ['replace_block', 'update_attrs', 'move_block', 'delete_block', 'transform_block'],
    },
    markdown: { anchors: 'comment' },
    render: { editor: 'codeBlock', readOnly: 'code' },
  },
  divider: {
    type: 'divider',
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'none',
    attrs: {},
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: ['replace_block', 'move_block', 'delete_block'],
    },
    markdown: { anchors: 'comment' },
    render: { editor: 'divider', readOnly: 'divider' },
  },
  table: {
    type: 'table',
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'table',
    attrs: { headerRows: { type: 'number', default: 1 } },
    allowedChildren: ['tableRow'],
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: [...CONTAINER_OPS],
    },
    markdown: { anchors: 'comment' },
    render: { editor: 'table', readOnly: 'table' },
  },
  tableRow: {
    type: 'tableRow',
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'blocks',
    attrs: {},
    allowedChildren: ['tableCell'],
    ai: {
      readable: false,
      writable: false,
      preview: 'markdown',
      ops: [],
    },
    markdown: { anchors: 'none' },
    render: { editor: 'tableRow', readOnly: 'none' },
  },
  tableCell: {
    type: 'tableCell',
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'inline',
    attrs: {},
    allowedMarks: [...MARK_TYPES],
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: [...CONTENT_OPS],
    },
    markdown: { anchors: 'none' },
    render: { editor: 'tableCell', readOnly: 'text' },
  },
  image: {
    type: 'image',
    schemaVersion: 1,
    kind: 'content',
    contentModel: 'none',
    attrs: {
      assetId: { type: 'assetRef', required: true },
      alt: { type: 'string', maxLength: 500 },
      caption: { type: 'string', maxLength: 500 },
      width: { type: 'string', maxLength: 32 },
    },
    ai: {
      readable: true,
      writable: true,
      preview: 'markdown',
      ops: [...MEDIA_OPS],
    },
    markdown: { anchors: 'comment' },
    render: { editor: 'image', readOnly: 'image' },
  },
  callout: containerNode('callout', {
    attrs: {
      tone: {
        type: 'string',
        required: true,
        enum: ['info', 'warn', 'success', 'danger'],
      },
      title: { type: 'string', maxLength: 200 },
      icon: { type: 'string', maxLength: 64 },
      collapsed: { type: 'boolean', default: false },
    },
    markdown: { anchors: 'comment', directive: 'callout' },
  }),
  mindmap: {
    type: 'mindmap',
    schemaVersion: 1,
    kind: 'structured',
    contentModel: 'none',
    attrs: {
      objectId: { type: 'objectRef', required: true },
      caption: { type: 'string', maxLength: 500 },
    },
    ai: {
      readable: true,
      writable: true,
      preview: 'placeholder',
      ops: [...OBJECT_OPS],
    },
    markdown: { anchors: 'comment', directive: 'mindmap' },
    render: { editor: 'mindmap', readOnly: 'object' },
  },
  component: {
    type: 'component',
    schemaVersion: 1,
    kind: 'application',
    contentModel: 'none',
    attrs: {
      objectId: { type: 'objectRef', required: true },
      title: { type: 'string', maxLength: 200 },
      description: { type: 'string', maxLength: 500 },
    },
    ai: {
      readable: true,
      writable: true,
      preview: 'placeholder',
      ops: [...OBJECT_OPS],
      describe: true,
    },
    markdown: { anchors: 'comment', directive: 'component' },
    render: { editor: 'component', readOnly: 'object' },
  },
};

/** Look up a node type definition. */
export function getNodeType(type: string): NodeTypeDefinition | undefined {
  return NODE_TYPES[type];
}

/** Require a known node type. */
export function requireNodeType(
  type: string,
  code: DocumentErrorCode = 'node/schema-invalid',
): NodeTypeDefinition {
  const definition = NODE_TYPES[type];
  if (definition === undefined)
    throw new DocumentError(code, `未知的节点类型：${type}`);
  return definition;
}

/** Apply defaults and drop undefined attributes for one new node. */
export function normalizeAttrs(
  type: string,
  attrs: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
  const definition = requireNodeType(type);
  const result: Record<string, JsonValue> = {};
  for (const [key, spec] of Object.entries(definition.attrs)) {
    const value = attrs?.[key];
    if (value === undefined) {
      if (spec.default !== undefined) result[key] = spec.default;
      continue;
    }
    result[key] = value;
  }
  for (const key of Object.keys(attrs ?? {})) {
    if (definition.attrs[key] === undefined)
      throw new DocumentError(
        'node/schema-invalid',
        `节点 ${type} 不支持属性 ${key}`,
      );
  }
  return result;
}

/** Create one block with schema defaults; ids are always caller-supplied. */
export function createBlockNode(
  id: string,
  type: string,
  options: {
    attrs?: Record<string, JsonValue>;
    content?: InlineNode[];
    children?: BlockNode[];
  } = {},
): BlockNode {
  const block: BlockNode = {
    id,
    type,
    attrs: normalizeAttrs(type, options.attrs),
  };
  if (options.content !== undefined) block.content = options.content;
  if (options.children !== undefined) block.children = options.children;
  return block;
}

/** Structural key of a node's payload for operation validation. */
export function nodeContentModel(type: string): ContentModel {
  return requireNodeType(type).contentModel;
}

/** Whether an AI/tool operation is allowed on a target node type. */
export function operationAllowedOn(type: string, op: OperationName): boolean {
  const definition = NODE_TYPES[type];
  if (definition === undefined) return false;
  return definition.ai.writable && definition.ai.ops.includes(op);
}

/** Whether `to` is a declared v0 transform of `from`. */
export function canTransform(from: string, to: string): boolean {
  return NODE_TYPES[from]?.transforms?.includes(to) ?? false;
}

function fail(code: DocumentErrorCode, message: string): never {
  throw new DocumentError(code, message);
}

function validateAttrs(block: BlockNode): void {
  const definition = requireNodeType(block.type);
  if (!isPlainObject(block.attrs))
    fail('node/schema-invalid', `节点 ${block.id} 的 attrs 必须是对象`);
  for (const key of Object.keys(block.attrs)) {
    if (definition.attrs[key] === undefined)
      fail('node/schema-invalid', `节点 ${block.type} 不支持属性 ${key}`);
  }
  for (const [key, spec] of Object.entries(definition.attrs)) {
    const value = block.attrs[key];
    if (value === undefined || value === null) {
      if (spec.required)
        fail('node/schema-invalid', `节点 ${block.type} 缺少属性 ${key}`);
      continue;
    }
    switch (spec.type) {
      case 'string':
      case 'assetRef':
      case 'objectRef':
        if (typeof value !== 'string' || value.trim() === '')
          fail('node/schema-invalid', `节点 ${block.type}.${key} 必须是非空字符串`);
        if (spec.maxLength !== undefined && value.length > spec.maxLength)
          fail('node/schema-invalid', `节点 ${block.type}.${key} 超过长度上限`);
        if (spec.type === 'assetRef' && !value.startsWith('asset_'))
          fail('node/schema-invalid', `${key} 不是有效资产 id`);
        if (spec.type === 'objectRef' && !value.startsWith('obj_'))
          fail('node/schema-invalid', `${key} 不是有效对象 id`);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          fail('node/schema-invalid', `节点 ${block.type}.${key} 必须是数字`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean')
          fail('node/schema-invalid', `节点 ${block.type}.${key} 必须是布尔值`);
        break;
      case 'json':
        break;
    }
    if (spec.enum !== undefined && !spec.enum.includes(value))
      fail(
        'node/schema-invalid',
        `节点 ${block.type}.${key} 必须是 ${spec.enum.map(String).join('/')}`,
      );
  }
}

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

function validateMarks(marks: Mark[] | undefined, type: string): void {
  if (marks === undefined) return;
  if (!Array.isArray(marks) || marks.length > 8)
    fail('node/schema-invalid', '行内 marks 必须是数组且不超过 8 项');
  const allowed = requireNodeType(type).allowedMarks ?? [];
  const seen = new Set<MarkType>();
  for (const mark of marks) {
    if (!isPlainObject(mark) || typeof mark.type !== 'string')
      fail('node/schema-invalid', '行内 mark 形状不正确');
    if (!MARK_TYPES.includes(mark.type as MarkType))
      fail('node/schema-invalid', `未知的行内 mark：${String(mark.type)}`);
    if (!allowed.includes(mark.type as MarkType))
      fail('node/schema-invalid', `节点 ${type} 不允许 mark ${mark.type}`);
    if (seen.has(mark.type as MarkType))
      fail('node/schema-invalid', `节点 ${type} 存在重复 mark ${mark.type}`);
    seen.add(mark.type as MarkType);
    if (mark.type === 'link') {
      const href = mark.attrs?.href;
      if (typeof href !== 'string' || !SAFE_HREF.test(href))
        fail('node/schema-invalid', 'link mark 需要合法的 href');
    }
  }
}

function validateInline(content: InlineNode[] | undefined, type: string): void {
  if (content === undefined) return;
  if (!Array.isArray(content)) fail('node/schema-invalid', `节点 ${type} 的 content 必须是数组`);
  for (const node of content) {
    if (!isPlainObject(node)) fail('node/schema-invalid', '行内内容必须是对象');
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0)
        fail('node/schema-invalid', '文本行内内容必须是非空字符串');
      validateMarks(node.marks as Mark[] | undefined, type);
    } else if (node.type === 'hardBreak') {
      if ('text' in node || 'marks' in node)
        fail('node/schema-invalid', 'hardBreak 不能携带文本或 marks');
    } else {
      const unknownType = (node as { type?: unknown }).type;
      fail('node/schema-invalid', `未知的行内类型：${String(unknownType)}`);
    }
  }
}

interface TreeStats {
  count: number;
}

function validateBlock(block: BlockNode, depth: number, stats: TreeStats): void {
  if (!isPlainObject(block)) fail('node/schema-invalid', 'block 必须是对象');
  if (typeof block.id !== 'string' || block.id.trim() === '')
    fail('node/schema-invalid', 'block.id 必须是非空字符串');
  if (typeof block.type !== 'string')
    fail('node/schema-invalid', `block ${block.id} 缺少 type`);
  if (depth > MAX_BLOCK_DEPTH) fail('node/schema-invalid', 'block 嵌套过深');
  stats.count += 1;
  if (stats.count > MAX_BLOCK_COUNT) fail('doc/schema-invalid', '文档 block 数量超过上限');
  const definition = requireNodeType(block.type);
  validateAttrs(block);

  if (definition.contentModel === 'inline') {
    if (block.children !== undefined)
      fail('node/schema-invalid', `节点 ${block.type} 不允许 children`);
    validateInline(block.content, block.type);
  } else if (definition.contentModel === 'none') {
    if (block.content !== undefined || block.children !== undefined)
      fail('node/schema-invalid', `节点 ${block.type} 不允许 content/children`);
  } else if (definition.contentModel === 'blocks') {
    if (block.content !== undefined)
      fail('node/schema-invalid', `节点 ${block.type} 不允许行内 content`);
    const children = block.children ?? [];
    if (!Array.isArray(children)) fail('node/schema-invalid', 'children 必须是数组');
    for (const child of children) {
      if (!isPlainObject(child) || typeof child.type !== 'string')
        fail('node/schema-invalid', '子 block 形状不正确');
      if (
        definition.allowedChildren !== undefined &&
        !definition.allowedChildren.includes(child.type)
      )
        fail('node/schema-invalid', `${block.type} 不允许子节点 ${child.type}`);
      validateBlock(child, depth + 1, stats);
    }
  } else if (definition.contentModel === 'table') {
    if (block.content !== undefined)
      fail('node/schema-invalid', '表格不允许行内 content');
    const children = block.children ?? [];
    if (!Array.isArray(children)) fail('node/schema-invalid', 'children 必须是数组');
    for (const child of children) {
      if (!isPlainObject(child) || child.type !== 'tableRow')
        fail('node/schema-invalid', 'table 只能包含 tableRow');
      validateBlock(child, depth + 1, stats);
    }
    const headerRows =
      typeof block.attrs.headerRows === 'number' ? block.attrs.headerRows : 0;
    if (headerRows < 0 || headerRows > children.length)
      fail('node/schema-invalid', 'headerRows 超出表格行数');
  }
}

/** Validate the whole document tree and size, throwing on any violation. */
export function validateAlterDoc(doc: AlterDoc): void {
  if (!isPlainObject(doc) || doc.format !== ALTER_DOC_FORMAT)
    fail('doc/schema-invalid', '文档 format 不是 alter-doc/1');
  if (doc.schemaVersion !== ALTER_DOC_SCHEMA_VERSION)
    fail(
      'doc/schema-invalid',
      `不支持的 schemaVersion ${String(doc.schemaVersion)}`,
    );
  if (!Number.isInteger(doc.revision) || doc.revision < 0)
    fail('doc/schema-invalid', '文档 revision 必须是非负整数');
  if (!Array.isArray(doc.blocks)) fail('doc/schema-invalid', '文档 blocks 必须是数组');
  const stats: TreeStats = { count: 0 };
  const ids = new Set<string>();
  for (const block of doc.blocks) {
    if (!isPlainObject(block) || typeof block.id !== 'string')
      fail('node/schema-invalid', '顶层 block 形状不正确');
    if (ids.has(block.id)) fail('node/schema-invalid', `重复的 block id：${block.id}`);
    ids.add(block.id);
    validateBlock(block, 1, stats);
  }
  const bytes = Buffer.byteLength(serializeAlterDoc(doc), 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES)
    fail('doc/too-large', `文档序列化后 ${bytes} 字节超过上限 ${MAX_DOCUMENT_BYTES}`);
}

/** Validate one operation batch's structure before the engine mutates anything. */
export function validateOperationsShape(ops: unknown): asserts ops is import('./types.js').Operation[] {
  if (!Array.isArray(ops) || ops.length === 0)
    fail('op/invalid', 'ops 必须是非空数组');
  if (ops.length > MAX_OPERATION_BATCH)
    fail('op/invalid', `单次最多 ${MAX_OPERATION_BATCH} 个 operation`);
  for (const [index, op] of ops.entries()) {
    if (!isPlainObject(op) || typeof op.op !== 'string')
      fail('op/invalid', `第 ${index} 个 operation 缺少 op`);
    const name = op.op;
    if (
      ![
        'insert_blocks',
        'insert_markdown',
        'replace_block',
        'update_text',
        'update_attrs',
        'move_block',
        'delete_block',
        'transform_block',
        'update_object',
      ].includes(name)
    )
      fail('op/invalid', `未知 operation：${name}`);
    if (name !== 'insert_blocks' && name !== 'insert_markdown' && typeof op.target !== 'string')
      fail('op/invalid', `第 ${index} 个 operation 缺少 target`);
  }
}

/** Validate one markdown/structured object payload for a block type. */
export function validateObjectPayload(
  type: string,
  payload: JsonValue,
): void {
  if (type === 'mindmap') {
    if (!isPlainObject(payload) || !isPlainObject(payload.root))
      fail('object/invalid', 'mindmap payload 需要 root 对象');
    const stack: unknown[] = [payload.root];
    let count = 0;
    while (stack.length > 0) {
      const node = stack.pop();
      count += 1;
      if (count > 500) fail('object/invalid', 'mindmap 节点数超过 500');
      if (
        !isPlainObject(node) ||
        typeof node.id !== 'string' ||
        typeof node.text !== 'string' ||
        node.text.length > 500
      )
        fail('object/invalid', 'mindmap 节点形状不正确');
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) fail('object/invalid', 'children 必须是数组');
        stack.push(...node.children);
      }
    }
    return;
  }
  if (type === 'component') {
    if (!isPlainObject(payload)) fail('object/invalid', 'component payload 必须是对象');
    if (payload.kind !== 'declarative')
      fail('object/invalid', 'v0 只支持声明式组件（kind="declarative"）');
    if (typeof payload.renderer !== 'string' || payload.renderer.trim() === '')
      fail('object/invalid', 'component 缺少 renderer');
    if (!isPlainObject(payload.props)) fail('object/invalid', 'component.props 必须是对象');
    if (payload.bindings !== undefined && !Array.isArray(payload.bindings))
      fail('object/invalid', 'component.bindings 必须是数组');
    return;
  }
  fail('object/invalid', `不支持的对象类型：${type}`);
}

/** Extract the plain text of one inline content array. */
export function plainTextOfInline(content: InlineNode[] | undefined): string {
  if (content === undefined) return '';
  let text = '';
  for (const node of content) {
    if (node.type === 'text') text += node.text;
    else text += '\n';
  }
  return text;
}

/** Extract the plain text of one textblock; non-inline blocks have none. */
export function plainTextOfBlock(block: BlockNode): string {
  return plainTextOfInline(block.content);
}

/** Validate one text edit payload shape for `update_text`. */
export function validateTextEdits(edits: unknown): asserts edits is TextEdit[] {
  if (!Array.isArray(edits) || edits.length === 0)
    fail('op/invalid', 'update_text 需要非空 edits');
  for (const edit of edits) {
    if (
      !isPlainObject(edit) ||
      typeof edit.oldText !== 'string' ||
      edit.oldText.length === 0 ||
      typeof edit.newText !== 'string'
    )
      fail('op/invalid', 'edit 需要非空 oldText 与字符串 newText');
    if (edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean')
      fail('op/invalid', 'edit.replaceAll 必须是布尔值');
  }
}

export type { BlockNode };
