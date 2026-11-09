/**
 * Alter document model v0 types.
 *
 * The canonical document is a typed block tree (`AlterDoc`) serialized into
 * `SpaceNode.content`; Markdown is a read-only projection and a new-content
 * input format, and structured/application payloads live in document side
 * tables. See `docs/specs/document-model-v0.md`.
 *
 * @module @alter-dsh/space/document/types
 */

/** Serialized format tag stored in `SpaceNode.content`. */
export const ALTER_DOC_FORMAT = 'alter-doc/1';
/** Current schema version of the block tree. */
export const ALTER_DOC_SCHEMA_VERSION = 1;
/** Upper bound for one serialized document (bytes, UTF-8). */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
/** Upper bound for one block tree depth. */
export const MAX_BLOCK_DEPTH = 50;
/** Upper bound for the number of blocks in one document. */
export const MAX_BLOCK_COUNT = 5_000;

/** JSON value allowed in attributes and object payloads. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Inline mark kinds supported by v0. */
export type MarkType =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'highlight'
  | 'link';

/** One inline mark applied to a text run. */
export interface Mark {
  type: MarkType;
  attrs?: { href?: string };
}

/** Inline content: styled text or a hard line break. */
export type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hardBreak' };

/** One block node in the document tree. */
export interface BlockNode {
  id: string;
  type: string;
  attrs: Record<string, JsonValue>;
  content?: InlineNode[];
  children?: BlockNode[];
}

/** Canonical serializable document. */
export interface AlterDoc {
  format: typeof ALTER_DOC_FORMAT;
  schemaVersion: number;
  /** Monotonic document revision; the optimistic-concurrency key. */
  revision: number;
  blocks: BlockNode[];
}

/** Who performed a document write. */
export type DocumentActor = 'user' | 'alter' | 'system';

/** One exact text edit inside a textblock's plain text. */
export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

/** A markdown→blocks parse function (injected to keep ops pure). */
export type MarkdownBlockParser = (
  source: string,
  options: { createBlockId: () => string },
) => BlockNode[];

/** A structured/application object factory (sidecar write is the caller's). */
export type DocumentObjectFactory = (input: {
  docId: string;
  blockId: string;
  type: 'mindmap' | 'component';
  payload: JsonValue;
}) => string;

/** Operation request (spec §5.2). */
export type Operation =
  | {
      op: 'insert_blocks';
      parent?: string | null;
      after?: string;
      index?: number;
      blocks?: BlockNode[];
      markdown?: string;
    }
  | {
      op: 'insert_markdown';
      parent?: string | null;
      after?: string;
      index?: number;
      markdown: string;
    }
  | {
      op: 'replace_block';
      target: string;
      blocks?: BlockNode[];
      markdown?: string;
    }
  | { op: 'update_text'; target: string; edits: TextEdit[] }
  | {
      op: 'update_attrs';
      target: string;
      attrs: Record<string, JsonValue | null>;
    }
  | {
      op: 'move_block';
      target: string;
      parent?: string | null;
      after?: string;
      index?: number;
    }
  | { op: 'delete_block'; target: string; mode?: 'remove' | 'unwrap' }
  | {
      op: 'transform_block';
      target: string;
      to: string;
      attrs?: Record<string, JsonValue>;
    }
  | { op: 'update_object'; target: string; payload: JsonValue };

/** Names used by operation validation. */
export type OperationName = Operation['op'];

/** Environment the pure operations engine needs. */
export interface OperationContext {
  docId: string;
  nowIso: () => string;
  createBlockId: () => string;
  parseMarkdown: MarkdownBlockParser;
  createObject: DocumentObjectFactory;
}

/** One machine-readable issue raised while validating/applying operations. */
export interface OperationIssue {
  index: number;
  code: string;
  message: string;
}

/** Diff summary returned by an apply. */
export interface AppliedOperation {
  index: number;
  op: OperationName;
  changedBlockIds: string[];
}

export interface OperationDiff {
  applied: AppliedOperation[];
  changedBlockIds: string[];
}

/** Result of applying a batch to one document. */
export interface OpsResult {
  doc: AlterDoc;
  diff: OperationDiff;
  /** Inverse operations, ordered so applying them in sequence undoes the batch. */
  inverseOps: Operation[];
}

/** Stable error codes of the document model (spec §5.4). */
export type DocumentErrorCode =
  | 'doc/not-found'
  | 'doc/conflict'
  | 'doc/too-large'
  | 'doc/schema-invalid'
  | 'doc/legacy-format'
  | 'op/invalid'
  | 'node/not-found'
  | 'node/schema-invalid'
  | 'node/unsupported-transform'
  | 'node/not-writable'
  | 'object/invalid'
  | 'parse/unsupported'
  | 'idempotency/conflict';

/** One document-model failure with a stable machine code. */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly issues?: OperationIssue[];

  constructor(
    code: DocumentErrorCode,
    message: string,
    issues?: OperationIssue[],
  ) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
    if (issues !== undefined) this.issues = issues;
  }
}

/** One immutable structured/application object (sidecar row). */
export interface DocumentObjectRecord {
  id: string;
  docId: string;
  type: 'mindmap' | 'component';
  schemaVersion: number;
  payload: JsonValue;
  provenance?: JsonValue;
  createdAt: string;
}

/** One content-addressed asset reference (sidecar row; bytes are separate). */
export interface DocumentAssetRecord {
  id: string;
  sha256: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  name?: string;
  createdAt: string;
}

/** One applied operation-log row. */
export interface DocumentOpRecord {
  id: string;
  docId: string;
  revision: number;
  actor: DocumentActor;
  ops: Operation[];
  inverseOps: Operation[];
  changedBlockIds: string[];
  diff: OperationDiff;
  /** Stored result for idempotent replays (JSON-safe). */
  result?: JsonValue;
  idempotencyKey?: string;
  createdAt: string;
}

/** Read/write view over the document side tables used inside a transaction. */
export interface DocumentSidecar {
  getObject(id: string): DocumentObjectRecord | undefined;
  listObjects(docId: string): DocumentObjectRecord[];
  putObject(record: DocumentObjectRecord): void;
  getAsset(id: string): DocumentAssetRecord | undefined;
  putAsset(record: DocumentAssetRecord): void;
  listOps(docId: string, limit?: number): DocumentOpRecord[];
  findOpByKey(docId: string, idempotencyKey: string): DocumentOpRecord | undefined;
  appendOp(record: DocumentOpRecord): void;
}

/** Result of parsing a stored node that may hold either format. */
export type StoredDocument =
  | { kind: 'alter-doc'; doc: AlterDoc }
  | { kind: 'legacy'; html: string; format?: string };

/** Whether a value is a plain JSON object. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Create the empty document a new AST-backed note starts from. */
export function createEmptyDoc(revision = 0): AlterDoc {
  return {
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision,
    blocks: [],
  };
}

/** Parse a stored content string into the canonical document when possible. */
export function parseAlterDoc(content: string): StoredDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: 'legacy', html: content };
  }
  if (
    isPlainObject(parsed) &&
    parsed.format === ALTER_DOC_FORMAT &&
    typeof parsed.schemaVersion === 'number' &&
    typeof parsed.revision === 'number' &&
    Array.isArray(parsed.blocks)
  ) {
    return { kind: 'alter-doc', doc: parsed as unknown as AlterDoc };
  }
  return { kind: 'legacy', html: content };
}

/** Serialize one document for persistence in `SpaceNode.content`. */
export function serializeAlterDoc(doc: AlterDoc): string {
  return JSON.stringify({
    format: ALTER_DOC_FORMAT,
    schemaVersion: ALTER_DOC_SCHEMA_VERSION,
    revision: doc.revision,
    blocks: doc.blocks,
  });
}
