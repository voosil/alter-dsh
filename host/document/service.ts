/**
 * Host-side document service for the Alter document model.
 *
 * Reads project the AST into Markdown; writes go through the pure operations
 * engine inside one store transaction, so the node row, object sidecars, the
 * operation log and the version snapshot commit or roll back together.
 *
 * @module @alter-dsh/space/document/service
 */
import { randomUUID } from 'node:crypto';
import type { SpaceNode } from '@alter/protocol';
import { trimTouchedVersions } from '../retention.js';
import type {
  SpaceStoreData,
  SpaceStoreHandle,
} from '../store.js';
import { applyOperations } from './ops.js';
import { parseMarkdownBlocks } from './markdown.js';
import { projectDocument } from './projection.js';
import {
  plainTextOfBlock,
  requireNodeType,
  validateAlterDoc,
  validateObjectPayload,
} from './schema.js';
import {
  ALTER_DOC_FORMAT,
  ALTER_DOC_SCHEMA_VERSION,
  DocumentError,
  parseAlterDoc,
  serializeAlterDoc,
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

/** Node shape stored in SQLite; `contentFormat` marks AST-backed documents. */
type DocNode = SpaceNode & { contentFormat?: string };

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
  actor?: DocumentActor;
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
  actor?: DocumentActor;
}

export interface GenerateDocumentResult {
  docId: string;
  revision: number;
  changedBlockIds: string[];
  title: string;
}

export interface DocumentServiceOptions {
  store: SpaceStoreHandle;
  /** Business clock; tests pin it. */
  now?: () => Date;
}

/** Result of a dry-run apply, never persisted. */
export interface DryRunResult {
  revision: number;
  diff: OperationDiff;
  warnings: string[];
}

export interface DocumentService {
  outline(docId: string): Promise<DocumentOutlineResult>;
  read(docId: string, options?: DocumentReadOptions): Promise<DocumentReadResult>;
  search(input: {
    query: string;
    docId?: string;
    spaceId?: string;
    limit?: number;
  }): Promise<DocumentSearchResult>;
  applyOperations(input: ApplyOperationsInput): Promise<ApplyOperationsResult>;
  generate(input: GenerateDocumentInput): Promise<GenerateDocumentResult>;
  getObject(objectId: string): Promise<DocumentObjectRecord | undefined>;
  updateObject(input: {
    docId: string;
    blockId: string;
    baseRevision: number;
    payload: JsonValue;
    actor?: DocumentActor;
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

function asDocNode(node: SpaceNode): DocNode {
  return node as DocNode;
}

/** Load one AST-backed document or fail with a stable code. */
function loadDocument(node: SpaceNode | undefined): AlterDoc {
  if (node === undefined) throw new DocumentError('doc/not-found', '文档不存在或已删除');
  const stored = parseAlterDoc(node.content);
  if (stored.kind !== 'alter-doc')
    throw new DocumentError(
      'doc/legacy-format',
      '该文档仍是旧 HTML 格式，暂不支持结构化读写；请先迁移后再使用文档模型工具',
    );
  return stored.doc;
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

function textOfBlockTree(block: BlockNode): string {
  const parts: string[] = [plainTextOfBlock(block)];
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
): void {
  // Keep the vendor service's five-minute version throttle on the AST path too.
  const latest = data.versions
    .filter((version) => version.docId === node.id)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  if (latest !== undefined && Date.parse(at) - Date.parse(latest.at) < 300_000)
    return;
  const previousLength = data.versions.length;
  data.versions.push({
    id: newVersionId(),
    docId: node.id,
    title: node.title,
    content: node.content,
    author: actor === 'alter' ? 'alter' : 'me',
    at,
  });
  trimTouchedVersions(data, previousLength, settings);
}

function touchNodeContent(
  data: SpaceStoreData,
  node: SpaceNode,
  actor: DocumentActor,
  at: string,
  settings: ReturnType<SpaceStoreHandle['getStorageSettings']>,
): void {
  node.updatedAt = at;
  const activity = node.activity;
  const canCredit =
    node.lastEditCreditAt === null ||
    Date.parse(at) - Date.parse(node.lastEditCreditAt) > 3_600_000;
  node.activity = Math.min(100, Math.max(0, activity + (canCredit ? 20 : 0)));
  node.activityAt = at;
  if (canCredit) node.lastEditCreditAt = at;
  recordVersion(data, node, actor, at, settings);
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

/**
 * Create the document service over one opened store.
 * @param options - raw store handle and business clock.
 */
export function createDocumentService(
  options: DocumentServiceOptions,
): DocumentService {
  const { store } = options;
  const now = options.now ?? (() => new Date());

  function topLevelOf(node: SpaceNode): AlterDoc {
    return loadDocument(node);
  }

  const api: DocumentService = {
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
        const stored = parseAlterDoc(node.content);
        if (stored.kind !== 'alter-doc') continue;
        const titleMatches = node.title.toLowerCase().includes(query);
        if (titleMatches) {
          hits.push({
            docId: node.id,
            spaceId: node.spaceId,
            title: node.title,
            blockId: stored.doc.blocks[0]?.id ?? null,
            type: 'document',
            preview: node.title.slice(0, 60),
          });
          if (hits.length >= limit) break;
        }
        const stack = [...stored.doc.blocks];
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
              preview: previewOf(block).slice(0, 60),
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
      const actor = input.actor ?? 'alter';
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
        const nextDoc: AlterDoc = { ...result.doc, revision };
        const content = serializeAlterDoc(nextDoc);
        node.content = content;
        asDocNode(node).contentFormat = ALTER_DOC_FORMAT;
        touchNodeContent(data, node, actor, at, settings);
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
      });
    },

    async generate(input) {
      const actor = input.actor ?? 'alter';
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
          const content = serializeAlterDoc({ ...result.doc, revision });
          node.content = content;
          asDocNode(node).contentFormat = ALTER_DOC_FORMAT;
          if (typeof input.title === 'string' && input.title.trim() !== '')
            node.title = input.title.trim();
          touchNodeContent(data, node, actor, at, settings);
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
        });
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
        const space = data.spaces.find((item) => item.id === spaceId);
        if (space === undefined) throw new DocumentError('doc/not-found', '空间不存在');
        const parentId = input.parent ?? null;
        if (parentId !== null) {
          const parent = findNode(data, parentId);
          if (parent === undefined || parent.spaceId !== spaceId)
            throw new DocumentError('op/invalid', '目标文件夹不存在');
          if (parent.kind !== 'folder')
            throw new DocumentError('op/invalid', '父节点必须是文件夹');
        }
        const siblings = data.nodes.filter(
          (node) =>
            node.spaceId === spaceId &&
            node.parentId === parentId &&
            node.deletedAt === null,
        );
        const docId = newNodeId();
        const node: DocNode = {
          id: docId,
          spaceId,
          kind: 'note',
          title: input.title?.trim() ?? '',
          parentId,
          creator: actor === 'alter' ? 'alter' : 'me',
          pinned: false,
          archived: false,
          archivedBy: null,
          archivedAt: null,
          deletedAt: null,
          deletedRoot: false,
          originalParentId: null,
          unread: false,
          content: serializeAlterDoc({ ...initial, revision: 1 }),
          contentFormat: ALTER_DOC_FORMAT,
          activity: 100,
          activityAt: at,
          lastOpenCreditAt: null,
          lastEditCreditAt: at,
          createdAt: at,
          updatedAt: at,
          order:
            siblings.reduce((min, item) => Math.min(min, item.order), 0) - 1,
        };
        data.nodes.push(node);
        recordVersion(data, node, actor, at, settings);
        return {
          docId,
          revision: 1,
          changedBlockIds: blocks.map((block) => block.id),
          title: node.title,
        };
      });
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
        ...(input.actor === undefined ? {} : { actor: input.actor }),
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
    },
  ): OpsResult {
    return applyOperations(doc, ops, {
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
    });
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
