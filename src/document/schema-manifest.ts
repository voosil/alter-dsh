/**
 * Client-side view of the Host node-type registry.
 *
 * The Host registry (`host/document/ast/schema.ts`) is the single source of
 * truth for node contracts, but the browser bundle must not import Host code
 * (it would drag Node types into the client graph). This module therefore
 * mirrors only what an editor kernel needs and keeps the mirror honest through
 * a contract test that compares it with the Host registry:
 *
 * - `tests/unit/document/schema-manifest.test.ts` fails when a node type, attr,
 *   mark set or content model in the Host registry is missing here.
 *
 * Kernels build their node schema from {@link nodesByContentModel}, so adding a
 * node type in the registry and forgetting the kernel is a test failure rather
 * than a silently missing node.
 *
 * @module @alter-dsh/space/document/schema-manifest
 */
import type { JsonValue } from './types';

/** Structural shape of a node's payload (mirrors the Host `ContentModel`). */
export type NodeContentModel = 'inline' | 'blocks' | 'none' | 'table';

/** Attribute rule (the subset of the Host `AttrSpec` a kernel maps). */
export interface NodeAttrSpec {
  type: 'string' | 'number' | 'boolean' | 'json' | 'assetRef' | 'objectRef';
  required?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  maxLength?: number;
}

/** One node type as an editor kernel needs it. */
export interface NodeManifestEntry {
  type: string;
  contentModel: NodeContentModel;
  attrs: Record<string, NodeAttrSpec>;
  /** Marks allowed inside this node; empty means plain text only. */
  marks: readonly string[];
  /** Allowed child node types when `contentModel === 'blocks'`. */
  children?: readonly string[];
}

/** Marks an AST owns (order is the canonical mark order). */
export const MARK_ORDER = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'highlight',
  'link',
] as const;

/** Node types in registry (display) order. */
export const NODE_MANIFEST: Readonly<Record<string, NodeManifestEntry>> = {
  paragraph: {
    type: 'paragraph',
    contentModel: 'inline',
    attrs: {},
    marks: MARK_ORDER,
  },
  heading: {
    type: 'heading',
    contentModel: 'inline',
    attrs: {
      level: { type: 'number', required: true, enum: [1, 2, 3, 4, 5, 6] },
    },
    marks: MARK_ORDER,
  },
  bulletList: {
    type: 'bulletList',
    contentModel: 'blocks',
    attrs: {},
    marks: [],
    children: ['listItem'],
  },
  orderedList: {
    type: 'orderedList',
    contentModel: 'blocks',
    attrs: { start: { type: 'number', default: 1 } },
    marks: [],
    children: ['listItem'],
  },
  taskList: {
    type: 'taskList',
    contentModel: 'blocks',
    attrs: {},
    marks: [],
    children: ['listItem'],
  },
  listItem: {
    type: 'listItem',
    contentModel: 'blocks',
    attrs: { checked: { type: 'boolean' } },
    marks: [],
  },
  blockquote: {
    type: 'blockquote',
    contentModel: 'blocks',
    attrs: {},
    marks: [],
  },
  codeBlock: {
    type: 'codeBlock',
    contentModel: 'inline',
    attrs: { lang: { type: 'string', maxLength: 32 } },
    // Code body is plain text: the Host rejects marks inside a code block.
    marks: [],
  },
  divider: {
    type: 'divider',
    contentModel: 'none',
    attrs: {},
    marks: [],
  },
  table: {
    type: 'table',
    contentModel: 'table',
    attrs: { headerRows: { type: 'number', default: 1 } },
    marks: [],
    children: ['tableRow'],
  },
  tableRow: {
    type: 'tableRow',
    contentModel: 'blocks',
    attrs: {},
    marks: [],
    children: ['tableCell'],
  },
  tableCell: {
    type: 'tableCell',
    contentModel: 'inline',
    attrs: {},
    marks: MARK_ORDER,
  },
  image: {
    type: 'image',
    contentModel: 'none',
    attrs: {
      assetId: { type: 'assetRef', required: true },
      alt: { type: 'string', maxLength: 500 },
      caption: { type: 'string', maxLength: 500 },
      width: { type: 'string', maxLength: 32 },
    },
    marks: [],
  },
  file: {
    type: 'file',
    contentModel: 'none',
    attrs: {
      assetId: { type: 'assetRef', required: true },
      name: { type: 'string', required: true, maxLength: 256 },
      mime: { type: 'string', required: true, maxLength: 128 },
      bytes: { type: 'number' },
    },
    marks: [],
  },
  bookmark: {
    type: 'bookmark',
    contentModel: 'none',
    attrs: {
      url: { type: 'string', required: true, maxLength: 2048 },
      title: { type: 'string', maxLength: 200 },
      description: { type: 'string', maxLength: 500 },
      icon: { type: 'string', maxLength: 64 },
    },
    marks: [],
  },
  docLink: {
    type: 'docLink',
    contentModel: 'none',
    attrs: {
      docId: { type: 'string', required: true, maxLength: 128 },
      title: { type: 'string', maxLength: 200 },
    },
    marks: [],
  },
  callout: {
    type: 'callout',
    contentModel: 'blocks',
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
    marks: [],
  },
  mindmap: {
    type: 'mindmap',
    contentModel: 'none',
    attrs: {
      objectId: { type: 'objectRef', required: true },
      caption: { type: 'string', maxLength: 500 },
    },
    marks: [],
  },
  component: {
    type: 'component',
    contentModel: 'none',
    attrs: {
      objectId: { type: 'objectRef', required: true },
      title: { type: 'string', maxLength: 200 },
      description: { type: 'string', maxLength: 500 },
    },
    marks: [],
  },
};

/** Every node type currently supported by an editor kernel. */
export const NODE_TYPES = Object.keys(NODE_MANIFEST);

/** Look up one node type entry. */
export function nodeManifestEntry(
  type: string,
): NodeManifestEntry | undefined {
  return NODE_MANIFEST[type];
}

/** Node types grouped by content model (stable registry order inside a group). */
export function nodesByContentModel(
  model: NodeContentModel,
): NodeManifestEntry[] {
  return NODE_TYPES.map((type) => NODE_MANIFEST[type]!).filter(
    (entry) => entry.contentModel === model,
  );
}

/** Whether a node type allows one mark. */
export function nodeAllowsMark(type: string, mark: string): boolean {
  return NODE_MANIFEST[type]?.marks.includes(mark) ?? false;
}