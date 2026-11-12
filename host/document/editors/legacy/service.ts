/**
 * Host-side document service for the Alter document model.
 *
 * Reads project the AST into Markdown; writes go through the pure operations
 * engine inside one store transaction, so the node row, object sidecars, the
 * operation log and the version snapshot commit or roll back together.
 *
 * @module @alter-dsh/space/document/editors/legacy/service
 */
import { randomUUID } from 'node:crypto';
import { creatorOf } from '../../../../vendor/protocol/src/space.js';
import type { SpaceActor, SpaceNode } from '@alter/protocol';
import { trimTouchedVersions } from '../../../persistence/retention.js';
import type {
  SpaceStoreData,
  SpaceStoreHandle,
} from '../../../persistence/store.js';
import { applyOperations } from '../../ast/operations.js';
import { cascadeDeletedComments } from '../../comments.js';
import { parseMarkdownBlocks } from './markdown.js';
import { projectDocument } from '../../ast/projection.js';
import {
  plainTextOfBlock,
  requireNodeType,
  validateAlterDoc,
  validateObjectPayload,
} from '../../ast/schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  MAX_DOCUMENT_BYTES,
  MAX_OPERATION_BATCH,
  parseAlterDoc,
  serializeAlterDoc,
  tryParseAlterDoc,
  type AlterDoc,
  type BlockNode,
  type DocumentActor,
  type DocumentObjectRecord,
  type DocumentOpRecord,
  type JsonValue,
  type Operation,
  type OperationDiff,
  type OpsResult,
} from './types.js';

/** One top-level block summary returned by `outline`. */
export interface DocumentOutlineEntry {
  id: string;
  type: string;
  preview: string;
  childCount: number;
}

export interface DocumentOutlineResult {
  docId: string;
  revision: number;
  title: string;
  totalBlocks: number;
  outline: DocumentOutlineEntry[];
}

export interface DocumentReadOptions {
  blocks?: string[];
  after?: string;
  limit?: number;
  maxChars?: number;
}

export interface DocumentReadResult {
  docId: string;
  revision: number;
  title: string;
  markdown: string;
  blocks: Array<{ id: string; type: string }>;
  truncated: boolean;
  next?: string;
}

export interface DocumentSearchHit {
  docId: string;
  spaceId: string;
  title: string;
  blockId: string | null;
  type: string;
  preview: string;
}

export interface DocumentSearchResult {
  query: string;
  hits: DocumentSearchHit[];
  truncated: boolean;
}

export interface ApplyOperationsInput {
  docId: string;
  baseRevision: number;
  ops: Operation[];
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface ApplyOperationsResult {
  docId: string;
  revision: number;
  changedBlockIds: string[];
  diff: OperationDiff;
  undoToken?: string;
  warnings: string[];
}

export interface GenerateDocumentInput {
  docId?: string;
  spaceId?: string;
  title?: string;
  parent?: string | null;
  after?: string;
  markdown: string;
}

export interface GenerateDocumentResult {
  docId: string;
  revision: number;
  changedBlockIds: string[];
  title: string;
}

export interface DocumentServiceOptions {
  store: SpaceStoreHandle;
  /**
   * Write identity this instance speaks for: `user` for the browser RPC,
   * `alter` for Agent tool ports. Attribution is derived from it; per-call
   * actor parameters do not exist.
   */
  actor: DocumentActor;
  /** Business clock; tests pin it. */
  now?: () => Date;
}

/** Result of a dry-run apply, never persisted. */
export interface DryRunResult {
  revision: number;
  diff: OperationDiff;
  warnings: string[];
}

export interface GetDocumentResult {
  docId: string;
  revision: number;
  title: string;
  doc: AlterDoc;
}

export interface UndoDocumentInput {
  docId: string;
  baseRevision: number;
  undoToken?: string;
}

export interface DocumentService {
  get(docId: string): Promise<GetDocumentResult>;
  outline(docId: string): Promise<DocumentOutlineResult>;
  read(docId: string, options?: DocumentReadOptions): Promise<DocumentReadResult>;
  search(input: {
    query: string;
    docId?: string;
    spaceId?: string;
    limit?: number;
  }): Promise<DocumentSearchResult>;
  applyOperations(input: ApplyOperationsInput): Promise<ApplyOperationsResult>;
  undo(input: UndoDocumentInput): Promise<ApplyOperationsResult>;
  restoreVersion(input: {
    docId: string;
    versionId: string;
    baseRevision: number;
  }): Promise<ApplyOperationsResult>;
  generate(input: GenerateDocumentInput): Promise<GenerateDocumentResult>;
  /** Create an empty AST-backed note (revision 1) in a Space. */
  createNote(input: {
    spaceId: string;
    title?: string;
    parentId?: string | null;
  }): Promise<SpaceNode>;
  getObject(objectId: string): Promise<DocumentObjectRecord | undefined>;
  updateObject(input: {
    docId: string;
    blockId: string;
    baseRevision: number;
    payload: JsonValue;
  }): Promise<ApplyOperationsResult & { objectId: string }>;
}

const MAX_READ_CHARS = 40_000;
const DEFAULT_READ_CHARS = 12_000;
const MAX_OUTLINE_ENTRIES = 200;
const OUTLINE_PREVIEW = 80;

function newNodeId(): string {
  return `doc-${randomUUID()}`;
}

function newBlockId(): string {
  return `blk_${randomUUID().replaceAll('-', '')}`;
}

function newVersionId(): string {
  return `ver-${randomUUID()}`;
}

function newObjectId(): string {
  return `obj_${randomUUID().replaceAll('-', '')}`;
}

function newOperationId(): string {
  return `op_${randomUUID().replaceAll('-', '')}`;
}

function nowIsoOf(now: () => Date): string {
  return now().toISOString();
}

function findNode(data: SpaceStoreData, docId: string): SpaceNode | undefined {
  return data.nodes.find(
    (node) => node.id === docId && node.deletedAt === null,
  ) as SpaceNode | undefined;
}

/** Load one document or fail with a stable code. */
function loadDocument(node: SpaceNode | undefined): AlterDoc {
  if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在或已删除');
  return parseAlterDoc(node.content);
}

function assertWritable(definition: { ai: { writable: boolean } }, op: string): void {
  if (!definition.ai.writable)
    throw new DocumentError('node/not-writable', `节点类型不允许 ${op}`);
}

function countBlocks(blocks: readonly BlockNode[]): number {
  let count = 0;
  const stack = [...blocks];
  while (stack.length > 0) {
    const block = stack.pop()!;
    count += 1;
    if (block.children !== undefined) stack.push(...block.children);
  }
  return count;
}

/** Preview around the matched query instead of the block's title attrs. */
function searchPreview(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const index = normalized.toLowerCase().indexOf(query);
  if (index < 0) return normalized.slice(0, 60);
  const budget = 60;
  const before = Math.min(index, 20);
  const start = Math.max(0, index - before);
  const available = budget - before;
  const end = Math.min(
    normalized.length,
    index + Math.max(query.length, available),
  );
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${
    end < normalized.length ? '…' : ''
  }`;
}

function previewOf(block: BlockNode): string {
  const text = plainTextOfBlock(block).replace(/\s+/g, ' ').trim();
  if (text !== '') return text.slice(0, OUTLINE_PREVIEW);
  const attrs = block.attrs;
  for (const key of ['title', 'caption', 'alt', 'description']) {
    const value = attrs[key];
    if (typeof value === 'string' && value.trim() !== '')
      return value.slice(0, OUTLINE_PREVIEW);
  }
  return block.type;
}

/**
 * Text attributes that carry searchable copy on structured/application blocks
 * (object alt/caption/title, card title/description/url).
 */
const SEARCHABLE_ATTR_KEYS = [
  'alt',
  'caption',
  'title',
  'description',
  'url',
] as const;

function textOfBlockTree(block: BlockNode): string {
  const parts: string[] = [plainTextOfBlock(block)];
  for (const key of SEARCHABLE_ATTR_KEYS) {
    const value = block.attrs[key];
    if (typeof value === 'string' && value.trim() !== '') parts.push(value);
  }
  if (block.children !== undefined)
    for (const child of block.children) parts.push(textOfBlockTree(child));
  return parts.join('\n');
}

function recordVersion(
  data: SpaceStoreData,
  node: SpaceNode,
  actor: DocumentActor,
  at: string,
  settings: ReturnType<SpaceStoreHandle['getStorageSettings']>,
  options: { force?: boolean; protect?: ReadonlySet<string> } = {},
): string | undefined {
  // User writes keep the vendor service's five-minute version throttle.
  // Alter writes force a version in the same transaction even inside the
  // throttle window, so every Agent edit stays recoverable; the regular
  // count/byte trimming still applies.
  const latest = data.versions
    .filter((version) => version.docId === node.id)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  if (
    options.force !== true &&
    actor !== 'alter' &&
    latest !== undefined &&
    Date.parse(at) - Date.parse(latest.at) < 300_000
  )
    return undefined;
  const id = newVersionId();
  const previousLength = data.versions.length;
  data.versions.push({
    id,
    docId: node.id,
    title: node.title,
    content: node.content,
    author: actor === 'alter' ? 'alter' : 'me',
    at,
  });
  const protect =
    options.protect === undefined
      ? undefined
      : new Set([...options.protect, id]);
  trimTouchedVersions(data, previousLength, settings, protect);
  return id;
}

/**
 * Commit one body write: persist the AST, touch node activity/versions and
 * cascade soft-deletion of comments whose quote no longer occurs in the body.
 *
 * Shared by every body write (`applyOperations`, `undo`, `restoreVersion`,
 * `generate`) so the cascade lives inside the same store transaction as the
 * body. The cascade only runs when the serialized body actually changed: a
 * metadata-only write can never orphan a comment.
 */
function writeDocumentBody(
  data: SpaceStoreData,
  node: SpaceNode,
  doc: AlterDoc,
  actor: DocumentActor,
  at: string,
  settings: ReturnType<SpaceStoreHandle['getStorageSettings']>,
  options: { protect?: ReadonlySet<string> } = {},
): void {
  const previous = node.content;
  const content = serializeAlterDoc(doc);
  node.content = content;
  touchNodeContent(data, node, actor, at, settings, options);
  if (content === previous) return;
  cascadeDeletedComments(
    data.comments,
    node.id,
    doc.blocks,
    at,
  );
}

function touchNodeContent(
  data: SpaceStoreData,
  node: SpaceNode,
  actor: DocumentActor,
  at: string,
  settings: ReturnType<SpaceStoreHandle['getStorageSettings']>,
  options: { protect?: ReadonlySet<string> } = {},
): void {
  node.updatedAt = at;
  const activity = node.activity;
  const canCredit =
    node.lastEditCreditAt === null ||
    Date.parse(at) - Date.parse(node.lastEditCreditAt) > 3_600_000;
  node.activity = Math.min(100, Math.max(0, activity + (canCredit ? 20 : 0)));
  node.activityAt = at;
  if (canCredit) node.lastEditCreditAt = at;
  recordVersion(data, node, actor, at, settings, options);
}

function nextTopLevelId(
  blocks: readonly BlockNode[],
  included: readonly { id: string }[],
): string | undefined {
  if (included.length === 0) return blocks[0]?.id;
  const lastId = included[included.length - 1]!.id;
  const index = blocks.findIndex((block) => block.id === lastId);
  if (index < 0) return undefined;
  return blocks[index + 1]?.id;
}

/** One note creation request; generate and createNote share the same write path. */
interface InsertNoteInput {
  spaceId: string;
  title: string;
  parentId: string | null;
  creator: 'me' | 'alter';
  blocks: BlockNode[];
  actor: DocumentActor;
  at: string;
  settings: ReturnType<SpaceStoreHandle['getStorageSettings']>;
}

/**
 * Append one AST-backed note to the store data and record its first version.
 * Callers run inside {@link SpaceStoreHandle.transactDocument}.
 */
function insertNote(data: SpaceStoreData, input: InsertNoteInput): SpaceNode {
  const space = data.spaces.find((item) => item.id === input.spaceId);
  if (space === undefined) throw new DocumentError('doc/not-found', '空间不存在');
  const parentId = input.parentId;
  if (parentId !== null) {
    // A note may live under a folder or under another note: the product shows
    // notes as sub-documents (`DocumentView` 子文档, sidebar quick-add) and the
    // tree/move paths already accept that shape. Only the parent's existence
    // and space membership are structural rules; folders stay root-only in the
    // vendor structure service, which owns folder placement.
    const parent = findNode(data, parentId);
    if (parent === undefined || parent.spaceId !== input.spaceId)
      throw new DocumentError('op/invalid', '父节点不存在或不属于当前空间');
  }
  const siblings = data.nodes.filter(
    (node) =>
      node.spaceId === input.spaceId &&
      node.parentId === parentId &&
      node.deletedAt === null,
  );
  const node: SpaceNode = {
    id: newNodeId(),
    spaceId: input.spaceId,
    kind: 'note',
    title: input.title,
    parentId,
    creator: input.creator,
    pinned: false,
    archived: false,
    archivedBy: null,
    archivedAt: null,
    deletedAt: null,
    deletedRoot: false,
    originalParentId: null,
    unread: false,
    content: serializeAlterDoc({
      format: ALTER_DOC_FORMAT,
      schemaVersion: ALTER_DOC_SCHEMA_VERSION,
      revision: 1,
      blocks: input.blocks,
    }),
    activity: 100,
    activityAt: input.at,
    lastOpenCreditAt: null,
    lastEditCreditAt: input.at,
    createdAt: input.at,
    updatedAt: input.at,
    order: siblings.reduce((min, item) => Math.min(min, item.order), 0) - 1,
  };
  data.nodes.push(node);
  recordVersion(data, node, input.actor, input.at, input.settings);
  return node;
}

/**
 * Create the document service over one opened store.
 * @param options - raw store handle and business clock.
 */
export function createDocumentService(
  options: DocumentServiceOptions,
): DocumentService {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  // The write identity is bound at construction; `system` is an op-log
  // provenance value, not a writable identity.
  if (options.actor !== 'user' && options.actor !== 'alter')
    throw new Error('DocumentService 需要明确的写入身份（user/alter）');
  const actor: SpaceActor = options.actor;
  const creator = creatorOf(actor);

  function topLevelOf(node: SpaceNode): AlterDoc {
    return loadDocument(node);
  }

  /**
   * Refuse to hand out a stored document above the write limit.
   *
   * The limit is enforced when content is written, but content can grow past it
   * by repeated appends (each save is checked against its own new size, and a
   * legacy/hand-edited row can be larger still). Returning such a document puts
   * the editor in a state where every further save fails for good; failing the
   * read instead keeps the failure explicit and recoverable.
   */
  function assertReadableSize(docId: string, content: string): void {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_DOCUMENT_BYTES)
      throw new DocumentError(
        'doc/too-large',
        `文档 ${docId} 序列化后 ${bytes} 字节超过上限 ${MAX_DOCUMENT_BYTES}；请用版本历史恢复到更小的版本，或从备份恢复`,
      );
  }

  const api: DocumentService = {
    async get(docId) {
      const node = findNode(store.read(), docId);
      if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
      const doc = loadDocument(node);
      assertReadableSize(docId, node.content);
      return { docId, revision: doc.revision, title: node.title, doc };
    },

    async outline(docId) {
      const node = findNode(store.read(), docId);
      if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
      const doc = topLevelOf(node);
      const entries: DocumentOutlineEntry[] = doc.blocks
        .slice(0, MAX_OUTLINE_ENTRIES)
        .map((block) => ({
          id: block.id,
          type: block.type,
          preview: previewOf(block),
          childCount: block.children?.length ?? 0,
        }));
      return {
        docId,
        revision: doc.revision,
        title: node.title,
        totalBlocks: countBlocks(doc.blocks),
        outline: entries,
      };
    },

    async read(docId, readOptions = {}) {
      const node = findNode(store.read(), docId);
      if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
      const doc = topLevelOf(node);
      const maxChars = Math.min(
        MAX_READ_CHARS,
        Math.max(1_000, readOptions.maxChars ?? DEFAULT_READ_CHARS),
      );
      const projection = projectDocument(doc, {
        ...(readOptions.blocks === undefined
          ? {}
          : { blockIds: readOptions.blocks }),
        ...(readOptions.after === undefined ? {} : { after: readOptions.after }),
        ...(readOptions.limit === undefined ? {} : { limit: readOptions.limit }),
        maxChars,
      });
      const next = projection.truncated
        ? nextTopLevelId(doc.blocks, projection.includedBlocks)
        : undefined;
      return {
        docId,
        revision: doc.revision,
        title: node.title,
        markdown: projection.markdown,
        blocks: projection.includedBlocks.map(({ id, type }) => ({ id, type })),
        truncated: projection.truncated,
        ...(next === undefined ? {} : { next }),
      };
    },

    async search(input) {
      const query = input.query.trim().toLowerCase();
      if (query === '') return { query: input.query, hits: [], truncated: false };
      const limit = Math.min(50, Math.max(1, input.limit ?? 20));
      const data = store.read();
      const docs: SpaceNode[] = [];
      if (input.docId !== undefined) {
        const node = findNode(data, input.docId);
        if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
        docs.push(node);
      } else if (input.spaceId !== undefined) {
        for (const node of data.nodes) {
          if (node.spaceId === input.spaceId && node.deletedAt === null && node.kind === 'note')
            docs.push(node as SpaceNode);
        }
      } else {
        throw new DocumentError('op/invalid', 'search 需要 doc_id 或 space_id');
      }
      const hits: DocumentSearchHit[] = [];
      for (const node of docs) {
        const doc = tryParseAlterDoc(node.content);
        if (doc === undefined) continue;
        const titleMatches = node.title.toLowerCase().includes(query);
        if (titleMatches) {
          hits.push({
            docId: node.id,
            spaceId: node.spaceId,
            title: node.title,
            blockId: doc.blocks[0]?.id ?? null,
            type: 'document',
            preview: node.title.slice(0, 60),
          });
          if (hits.length >= limit) break;
        }
        const stack = [...doc.blocks];
        while (stack.length > 0) {
          const block = stack.pop()!;
          const text = textOfBlockTree(block).toLowerCase();
          if (text.includes(query)) {
            hits.push({
              docId: node.id,
              spaceId: node.spaceId,
              title: node.title,
              blockId: block.id,
              type: block.type,
              preview: searchPreview(text, query),
            });
            if (hits.length >= limit) break;
          }
          if (block.children !== undefined) stack.push(...block.children);
        }
        if (hits.length >= limit) break;
      }
      return { query: input.query, hits, truncated: hits.length >= limit };
    },

    async applyOperations(input) {
      const at = nowIsoOf(now);
      const settings = store.getStorageSettings();

      if (input.dryRun === true) {
        const node = findNode(store.read(), input.docId);
        const doc = loadDocument(node);
        if (input.baseRevision !== doc.revision)
          throw new DocumentError(
            'doc/conflict',
            `文档已被修改（当前 revision=${doc.revision}）`,
          );
        const result = applyDocumentOperations(doc, input.ops, input.docId, at);
        return {
          docId: input.docId,
          revision: doc.revision,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          warnings: [],
        };
      }

      return store.transactDocument((data, sidecar) => {
        const node = findNode(data, input.docId);
        if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
        if (input.idempotencyKey !== undefined) {
          const existing = sidecar.findOpByKey(input.docId, input.idempotencyKey);
          if (existing !== undefined) {
            if (JSON.stringify(existing.ops) !== JSON.stringify(input.ops))
              throw new DocumentError(
                'idempotency/conflict',
                '同一 idempotency_key 已用于不同的 operations',
              );
            if (existing.result !== undefined)
              return existing.result as unknown as ApplyOperationsResult;
          }
        }
        const doc = loadDocument(node);
        if (input.baseRevision !== doc.revision)
          throw new DocumentError(
            'doc/conflict',
            `文档已被修改（当前 revision=${doc.revision}，提交基于 ${input.baseRevision}）`,
          );
        const result = applyDocumentOperations(doc, input.ops, input.docId, at, {
          sidecar,
          actor,
        });
        const revision = doc.revision + 1;
        writeDocumentBody(
          data,
          node,
          { ...result.doc, revision },
          actor,
          at,
          settings,
        );
        const op: DocumentOpRecord = {
          id: newOperationId(),
          docId: input.docId,
          revision,
          actor,
          ops: input.ops,
          inverseOps: result.inverseOps,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          result: {
            docId: input.docId,
            revision,
            changedBlockIds: result.diff.changedBlockIds,
            diff: result.diff as unknown as JsonValue,
            undoToken: '',
            warnings: [],
          } as unknown as JsonValue,
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
          createdAt: at,
        };
        sidecar.appendOp(op);
        const response: ApplyOperationsResult = {
          docId: input.docId,
          revision,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          undoToken: op.id,
          warnings: [],
        };
        if (op.result !== undefined) op.result = response as unknown as JsonValue;
        return response;
      }, actor);
    },

    async undo(input) {
      const at = nowIsoOf(now);
      const settings = store.getStorageSettings();
      return store.transactDocument((data, sidecar) => {
        const node = findNode(data, input.docId);
        if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
        const doc = loadDocument(node);
        if (input.baseRevision !== doc.revision)
          throw new DocumentError(
            'doc/conflict',
            `文档已被修改（当前 revision=${doc.revision}，提交基于 ${input.baseRevision}）`,
          );
        const operations = sidecar.listOps(input.docId);
        const target =
          input.undoToken === undefined
            ? operations[operations.length - 1]
            : operations.find((record) => record.id === input.undoToken);
        if (target === undefined)
          throw new DocumentError('op/invalid', '没有可撤销的操作');
        if (target.inverseOps.length === 0)
          throw new DocumentError('op/invalid', '该操作没有可撤销的逆操作');
        const result = applyDocumentOperations(
          doc,
          target.inverseOps,
          input.docId,
          at,
          // The inverse batch is engine-generated: replaying it must not be
          // blocked by the AI capability gates that applied to the original
          // user/AI batch (schema/size/existence checks still run).
          { sidecar, actor, trusted: true },
        );
        const revision = doc.revision + 1;
        writeDocumentBody(data, node, { ...result.doc, revision }, actor, at, settings);
        const op: DocumentOpRecord = {
          id: newOperationId(),
          docId: input.docId,
          revision,
          actor,
          ops: target.inverseOps,
          inverseOps: target.ops,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          createdAt: at,
        };
        sidecar.appendOp(op);
        return {
          docId: input.docId,
          revision,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          undoToken: op.id,
          warnings: [],
        };
      }, actor);
    },

    async restoreVersion(input) {
      const at = nowIsoOf(now);
      const settings = store.getStorageSettings();
      return store.transactDocument((data, sidecar) => {
        const node = findNode(data, input.docId);
        if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
        const doc = loadDocument(node);
        if (input.baseRevision !== doc.revision)
          throw new DocumentError(
            'doc/conflict',
            `文档已被修改（当前 revision=${doc.revision}，提交基于 ${input.baseRevision}）`,
          );
        const version = data.versions.find(
          (item) => item.id === input.versionId && item.docId === input.docId,
        );
        if (version === undefined)
          throw new DocumentError('op/invalid', '历史版本不存在');
        const restored = parseAlterDoc(version.content);
        // Record the pre-restore body before rewriting anything: without it the
        // restore is the one irreversible action in the product (the whole point
        // of a restore is that the previous state may be the good one). It is
        // protected from trimming below, so even the minimum history limit keeps
        // a way back.
        const undoPointId = recordVersion(data, node, actor, at, settings, {
          force: true,
        });
        const undoPoint =
          undoPointId === undefined ? undefined : new Set([undoPointId]);
        const ops: Operation[] = doc.blocks.map((block) => ({
          op: 'delete_block' as const,
          target: block.id,
        }));
        if (restored.blocks.length > 0) {
          ops.push({
            op: 'insert_blocks',
            parent: null,
            index: 0,
            blocks: restored.blocks,
          });
        }
        if (ops.length === 0) throw new DocumentError('op/invalid', '没有可恢复的内容');
        if (ops.length > MAX_OPERATION_BATCH)
          throw new DocumentError(
            'op/invalid',
            `历史版本恢复需要 ${ops.length} 个 operation，超过单批上限 ${MAX_OPERATION_BATCH}`,
          );
        const result = applyDocumentOperations(doc, ops, input.docId, at, {
          sidecar,
          actor,
          // Restore rewrites the whole tree from a stored snapshot; treat it
          // as a system replay so non-AI-writable container blocks can be
          // deleted/re-inserted, while schema validation still applies.
          trusted: true,
        });
        const revision = doc.revision + 1;
        node.title = version.title;
        writeDocumentBody(
          data,
          node,
          { ...result.doc, revision },
          actor,
          at,
          settings,
          undoPoint === undefined ? {} : { protect: undoPoint },
        );
        sidecar.appendOp({
          id: newOperationId(),
          docId: input.docId,
          revision,
          actor,
          ops,
          inverseOps: result.inverseOps,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          createdAt: at,
        });
        return {
          docId: input.docId,
          revision,
          changedBlockIds: result.diff.changedBlockIds,
          diff: result.diff,
          warnings: [],
        };
      }, actor);
    },

    async generate(input) {
      const at = nowIsoOf(now);
      const settings = store.getStorageSettings();

      if (input.docId !== undefined) {
        const documentId = input.docId;
        return store.transactDocument((data, sidecar) => {
          const node = findNode(data, documentId);
          if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在');
          const doc = loadDocument(node);
          const result = applyDocumentOperations(
            doc,
            [
              {
                op: 'insert_markdown',
                markdown: input.markdown,
                ...(input.parent === undefined ? {} : { parent: input.parent }),
                ...(input.after === undefined ? {} : { after: input.after }),
              },
            ],
            documentId,
            at,
            { sidecar, actor },
          );
          const revision = doc.revision + 1;
          if (typeof input.title === 'string' && input.title.trim() !== '')
            node.title = input.title.trim();
          writeDocumentBody(data, node, { ...result.doc, revision }, actor, at, settings);
          sidecar.appendOp({
            id: newOperationId(),
            docId: documentId,
            revision,
            actor,
            ops: [{ op: 'insert_markdown', markdown: input.markdown }],
            inverseOps: result.inverseOps,
            changedBlockIds: result.diff.changedBlockIds,
            diff: result.diff,
            createdAt: at,
          });
          return {
            docId: documentId,
            revision,
            changedBlockIds: result.diff.changedBlockIds,
            title: node.title,
          };
        }, actor);
      }

      if (input.spaceId === undefined || input.spaceId.trim() === '')
        throw new DocumentError('op/invalid', '新建文档需要 space_id');
      const spaceId = input.spaceId;
      const blocks = parseMarkdownBlocks(input.markdown, {
        createBlockId: newBlockId,
        hasAsset: (id) => store.getDocumentAsset(id) !== undefined,
      });
      const initial: AlterDoc = {
        format: ALTER_DOC_FORMAT,
        schemaVersion: ALTER_DOC_SCHEMA_VERSION,
        revision: 0,
        blocks,
      };
      validateAlterDoc(initial);
      return store.transactDocument((data) => {
        const node = insertNote(data, {
          spaceId,
          title: input.title?.trim() ?? '',
          parentId: input.parent ?? null,
          creator,
          blocks,
          actor,
          at,
          settings,
        });
        return {
          docId: node.id,
          revision: 1,
          changedBlockIds: blocks.map((block) => block.id),
          title: node.title,
        };
      }, actor);
    },

    async createNote(input) {
      const at = nowIsoOf(now);
      const settings = store.getStorageSettings();
      return store.transactDocument((data) => {
        const node = insertNote(data, {
          spaceId: input.spaceId,
          title: input.title?.trim() ?? '',
          parentId: input.parentId ?? null,
          creator,
          blocks: [],
          actor,
          at,
          settings,
        });
        return { ...node };
      }, actor);
    },

    async getObject(objectId) {
      return store.getDocumentObject(objectId);
    },

    async updateObject(input) {
      const result = await api.applyOperations({
        docId: input.docId,
        baseRevision: input.baseRevision,
        ops: [
          {
            op: 'update_object',
            target: input.blockId,
            payload: input.payload,
          },
        ],
      });
      const node = findNode(store.read(), input.docId);
      const block =
        node === undefined
          ? undefined
          : findBlockById(loadDocument(node), input.blockId);
      const objectId = block?.attrs.objectId;
      if (typeof objectId !== 'string')
        throw new DocumentError('object/invalid', '更新对象后未找到 objectId');
      return { ...result, objectId };
    },
  };
  return api;

  function applyObjectPayload(
    docId: string,
    block: BlockNode,
    payload: JsonValue,
    at: string,
    sidecar: import('./types.js').DocumentSidecar,
    actor: DocumentActor,
  ): string {
    const definition = requireNodeType(block.type);
    assertWritable(definition, 'update_object');
    const objectType = block.type === 'mindmap' ? 'mindmap' : 'component';
    validateObjectPayload(objectType, payload);
    const id = newObjectId();
    const record: DocumentObjectRecord = {
      id,
      docId,
      type: objectType,
      schemaVersion: 1,
      payload,
      provenance: { generatedBy: actor, at },
      createdAt: at,
    };
    sidecar.putObject(record);
    return id;
  }

  function applyDocumentOperations(
    doc: AlterDoc,
    ops: Operation[],
    docId: string,
    at: string,
    context?: {
      sidecar: import('./types.js').DocumentSidecar;
      actor: DocumentActor;
      /** Internal inverse/restore replay: bypass AI capability gates. */
      trusted?: boolean;
    },
  ): OpsResult {
    return applyOperations(
      doc,
      ops,
      {
        docId,
        nowIso: () => at,
        createBlockId: newBlockId,
        parseMarkdown: (source, parseOptions) =>
          parseMarkdownBlocks(source, {
            createBlockId: parseOptions.createBlockId,
            hasAsset: (id) => store.getDocumentAsset(id) !== undefined,
          }),
        createObject: ({ blockId, type, payload }) => {
          const block = findBlockById(doc, blockId);
          if (block === undefined)
            throw new DocumentError('node/not-found', `节点不存在：${blockId}`);
          if (block.type !== type)
            throw new DocumentError('object/invalid', '对象类型与节点不一致');
          if (context === undefined) {
            validateObjectPayload(type, payload);
            return newObjectId();
          }
          return applyObjectPayload(
            docId,
            block,
            payload,
            at,
            context.sidecar,
            context.actor,
          );
        },
      },
      { trusted: context?.trusted === true },
    );
  }

  function findBlockById(doc: AlterDoc, id: string): BlockNode | undefined {
    const stack = [...doc.blocks];
    while (stack.length > 0) {
      const block = stack.pop()!;
      if (block.id === id) return block;
      if (block.children !== undefined) stack.push(...block.children);
    }
    return undefined;
  }
}
