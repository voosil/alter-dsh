/**
 * Model-facing Agent tools for the Alter document model.
 *
 * The tools expose Markdown projections for reading and Document Operations
 * for writing; they never accept or return raw AST JSON as free text. DSH's
 * tool framework validates only JSON syntax, so every argument is checked here.
 *
 * @module @alter-dsh/space/document/tools
 */
import type { JsonValue } from './types.js';
import type {
  ApplyOperationsInput,
  DocumentService,
} from './service.js';

/** Minimal text content block returned to the model. */
export interface ToolTextBlock {
  type: 'text';
  text: string;
}

/** JSON-schema subset accepted by the Host tool pipeline. */
export interface JsonSchemaLike {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  oneOf?: JsonSchemaLike[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaLike;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  description?: string;
  default?: JsonValue;
}

/** Structural subset of the DSH tool execution context used by the tools. */
export interface ToolRunContextLike {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly agent?: unknown;
}

/** Structural subset of a DSH tool definition. */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: JsonSchemaLike;
    render(args: unknown, value: unknown): ToolTextBlock[];
  };
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): unknown;
}

/** Structural subset of the DSH tools service. */
export interface ToolsLike {
  register(
    definition: ToolDefinitionLike,
    options?: {
      when?: (context: { agent?: unknown }) => boolean | Promise<boolean>;
    },
  ): () => void;
}

export interface DocumentToolDeps {
  service: DocumentService;
}

function view(value: unknown): JsonValue {
  return value as unknown as JsonValue;
}

function invalid(message: string): never {
  throw new Error(`space/invalid-args: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('参数必须是对象');
  return value as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '')
    invalid(`${key} 必须是非空字符串`);
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${key} 必须是字符串`);
  return value;
}

function requireInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    invalid(`${key} 必须是非负整数`);
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value))
    invalid(`${key} 必须是整数`);
  if (bounds.min !== undefined && value < bounds.min)
    invalid(`${key} 至少为 ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max)
    invalid(`${key} 最多为 ${bounds.max}`);
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(`${key} 必须是布尔值`);
  return value;
}

function stringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    invalid(`${key} 必须是字符串数组`);
  return value as string[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function text(value: string): ToolTextBlock {
  return { type: 'text', text: value };
}

function renderOutline(value: unknown): ToolTextBlock[] {
  const result = value as {
    title: string;
    revision: number;
    total_blocks: number;
    outline: Array<{ id: string; type: string; preview: string }>;
  };
  const lines = result.outline.map(
    (entry) => `- ${entry.id} [${entry.type}] ${entry.preview}`,
  );
  return [
    text(
      [
        `文档《${result.title}》revision=${result.revision}，共 ${result.total_blocks} 个块。`,
        ...lines,
        result.outline.length === 0 ? '（空文档）' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ];
}

function renderOps(value: unknown): ToolTextBlock[] {
  const result = value as {
    revision: number;
    changed_block_ids: string[];
    undo_token?: string;
  };
  return [
    text(
      [
        `已应用，revision=${result.revision}；涉及块 ${result.changed_block_ids.length} 个。`,
        result.undo_token === undefined ? '' : `undoToken=${result.undo_token}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ];
}

const objectOutputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'schema_version', 'payload'],
  properties: {
    type: { type: 'string' },
    schema_version: { type: 'integer' },
    payload: { type: 'object', additionalProperties: true, properties: {} },
    provenance: { type: 'object', additionalProperties: true, properties: {} },
  },
};

/** Read one stored object through the document service. */
async function readObject(
  service: DocumentService,
  objectId: string,
): Promise<Record<string, unknown>> {
  const record = await service.getObject(objectId);
  if (record === undefined) throw new Error('object/not-found: 对象不存在');
  return {
    type: record.type,
    schema_version: record.schemaVersion,
    payload: record.payload,
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
  };
}

/**
 * Register the seven document tools on one Host tools service.
 * @returns disposer that removes every registration.
 */
export function registerDocumentTools(
  tools: ToolsLike,
  deps: DocumentToolDeps,
): () => void {
  const disposers: Array<() => void> = [];
  const { service } = deps;

  disposers.push(
    tools.register({
      name: 'space_doc_outline',
      description:
        'Read the block outline of one Space document (ids, types and short previews). Call this before reading or editing so you have stable block ids.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['doc_id'],
        properties: {
          doc_id: {
            type: 'string',
            description: 'Document id from a Space listing or search.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'title', 'total_blocks', 'outline'],
          properties: {
            revision: { type: 'integer' },
            title: { type: 'string' },
            total_blocks: { type: 'integer' },
            outline: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'type', 'preview', 'child_count'],
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  preview: { type: 'string' },
                  child_count: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => renderOutline(value),
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = asRecord(args);
        try {
          const result = await service.outline(requireString(input, 'doc_id'));
          return {
            revision: result.revision,
            title: result.title,
            total_blocks: result.totalBlocks,
            outline: result.outline.map((entry) => ({
              id: entry.id,
              type: entry.type,
              preview: entry.preview,
              child_count: entry.childCount,
            })),
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Read document outline', kind: 'read' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_doc_read',
      description:
        'Read one Space document as Markdown with block anchors; use block_ids/after/limit for long documents. The revision returned must be used as base_revision for writes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['doc_id'],
        properties: {
          doc_id: { type: 'string', description: 'Document id.' },
          blocks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only project these top-level block ids.',
          },
          after: {
            type: 'string',
            description: 'Start after this top-level block id.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum top-level blocks. Defaults to all.',
          },
          max_chars: {
            type: 'integer',
            description: 'Character budget; 1000-40000, defaults to 12000.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'markdown', 'blocks', 'truncated'],
          properties: {
            revision: { type: 'integer' },
            markdown: { type: 'string' },
            blocks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'type'],
                properties: { id: { type: 'string' }, type: { type: 'string' } },
              },
            },
            truncated: { type: 'boolean' },
            next: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const result = value as {
            markdown: string;
            revision: number;
            truncated: boolean;
            next?: string;
          };
          return [
            text(
              [
                result.markdown,
                `\n<!-- revision=${result.revision}${
                  result.truncated
                    ? `; truncated; next=${result.next ?? ''}`
                    : ''
                } -->`,
              ].join(''),
            ),
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = asRecord(args);
        try {
          const blocks = stringArray(input, 'blocks');
          const after = optionalString(input, 'after');
          const limit = optionalInteger(input, 'limit', { min: 1, max: 500 });
          const maxChars = optionalInteger(input, 'max_chars', {
            min: 1_000,
            max: 40_000,
          });
          const result = await service.read(requireString(input, 'doc_id'), {
            ...(blocks === undefined ? {} : { blocks }),
            ...(after === undefined ? {} : { after }),
            ...(limit === undefined ? {} : { limit }),
            ...(maxChars === undefined ? {} : { maxChars }),
          });
          return {
            revision: result.revision,
            markdown: result.markdown,
            blocks: result.blocks.map(({ id, type }) => ({ id, type })),
            truncated: result.truncated,
            ...(result.next === undefined ? {} : { next: result.next }),
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Read Space document', kind: 'read' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_doc_search',
      description:
        'Search one Space document (or a whole space) by text and return matching block ids. Use it to locate content in long documents.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Text to find (case-insensitive).',
          },
          doc_id: { type: 'string', description: 'Limit to one document.' },
          space_id: { type: 'string', description: 'Limit to one space.' },
          limit: {
            type: 'integer',
            description: 'Maximum hits, 1-50, defaults to 20.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'hits', 'truncated'],
          properties: {
            query: { type: 'string' },
            truncated: { type: 'boolean' },
            hits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['doc_id', 'block_id', 'type', 'preview'],
                properties: {
                  doc_id: { type: 'string' },
                  block_id: { type: 'string' },
                  type: { type: 'string' },
                  preview: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const result = value as {
            hits: Array<{
              doc_id: string;
              block_id: string;
              type: string;
              preview: string;
            }>;
            truncated: boolean;
          };
          const lines = result.hits.map(
            (hit) =>
              `- ${hit.doc_id} / ${hit.block_id} [${hit.type}] ${hit.preview}`,
          );
          return [
            text(
              [...lines, result.truncated ? '(truncated)' : '']
                .filter(Boolean)
                .join('\n') || '没有命中',
            ),
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = asRecord(args);
        try {
          const result = await service.search({
            query: requireString(input, 'query'),
            ...(optionalString(input, 'doc_id') === undefined
              ? {}
              : { docId: optionalString(input, 'doc_id') }),
            ...(optionalString(input, 'space_id') === undefined
              ? {}
              : { spaceId: optionalString(input, 'space_id') }),
            ...(optionalInteger(input, 'limit', { min: 1, max: 50 }) ===
            undefined
              ? {}
              : { limit: optionalInteger(input, 'limit', { min: 1, max: 50 }) }),
          });
          return {
            query: result.query,
            truncated: result.truncated,
            hits: result.hits.map((hit) => ({
              doc_id: hit.docId,
              block_id: hit.blockId ?? '',
              type: hit.type,
              preview: hit.preview,
            })),
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Search Space document', kind: 'search' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_doc_ops',
      description:
        'Apply a batch of Document Operations to one Space document. Every operation targets a block id; the batch is atomic and requires the current base_revision from a read/outline. For update_text, edits[].oldText must be the plain text without Markdown marks (bold text **x** matches x).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['doc_id', 'base_revision', 'ops'],
        properties: {
          doc_id: { type: 'string', description: 'Document id.' },
          base_revision: {
            type: 'integer',
            description: 'Revision from space_doc_read.',
          },
          ops: {
            type: 'array',
            description:
              'Operation objects (insert_blocks/update_text/update_attrs/move_block/delete_block/transform_block/update_object/replace_block/insert_markdown).',
            items: { type: 'object' },
          },
          dry_run: {
            type: 'boolean',
            description: 'Validate and diff without writing.',
          },
          idempotency_key: {
            type: 'string',
            description: 'Optional replay key.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'changed_block_ids', 'diff', 'warnings'],
          properties: {
            revision: { type: 'integer' },
            changed_block_ids: { type: 'array', items: { type: 'string' } },
            diff: { type: 'object', additionalProperties: true, properties: {} },
            undo_token: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => renderOps(value),
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const input = asRecord(args);
        try {
          const dryRun = optionalBoolean(input, 'dry_run');
          const idempotencyKey = optionalString(input, 'idempotency_key');
          const result = await service.applyOperations({
            docId: requireString(input, 'doc_id'),
            baseRevision: requireInteger(input, 'base_revision'),
            ops: input.ops as ApplyOperationsInput['ops'],
            ...(dryRun === undefined ? {} : { dryRun }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          });
          return {
            revision: result.revision,
            changed_block_ids: result.changedBlockIds,
            diff: result.diff as unknown as JsonValue,
            ...(result.undoToken === undefined
              ? {}
              : { undo_token: result.undoToken }),
            warnings: result.warnings,
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({
          card: 'generic',
          title: 'Apply document operations',
          kind: 'edit',
        }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_doc_generate',
      description:
        'Create a Space document from Markdown, or insert new Markdown content at a target position in an existing document. Only new content is generated; precise edits use space_doc_ops.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['markdown'],
        properties: {
          markdown: {
            type: 'string',
            description: 'Markdown (CommonMark/GFM + supported directives).',
          },
          doc_id: {
            type: 'string',
            description: 'Insert into this document instead of creating one.',
          },
          space_id: { type: 'string', description: 'Space for a new document.' },
          title: { type: 'string', description: 'New document title.' },
          parent: {
            type: 'string',
            description: 'Parent folder id (new documents).',
          },
          after: {
            type: 'string',
            description: 'Insert after this top-level block id.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['doc_id', 'revision', 'changed_block_ids', 'title'],
          properties: {
            doc_id: { type: 'string' },
            revision: { type: 'integer' },
            changed_block_ids: { type: 'array', items: { type: 'string' } },
            title: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const result = value as {
            doc_id: string;
            title: string;
            revision: number;
          };
          return [
            text(
              `已生成《${result.title || '未命名文档'}》（${result.doc_id}），revision=${result.revision}。`,
            ),
          ];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const input = asRecord(args);
        try {
          const docId = optionalString(input, 'doc_id');
          const spaceId = optionalString(input, 'space_id');
          const title = optionalString(input, 'title');
          const parent = optionalString(input, 'parent');
          const after = optionalString(input, 'after');
          const result = await service.generate({
            markdown: requireString(input, 'markdown'),
            ...(docId === undefined ? {} : { docId }),
            ...(spaceId === undefined ? {} : { spaceId }),
            ...(title === undefined ? {} : { title }),
            ...(parent === undefined ? {} : { parent }),
            ...(after === undefined ? {} : { after }),
          });
          return {
            doc_id: result.docId,
            revision: result.revision,
            changed_block_ids: result.changedBlockIds,
            title: result.title,
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({
          card: 'generic',
          title: 'Generate Space document',
          kind: 'edit',
        }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_object_get',
      description:
        'Read the structured payload of a mindmap/component object referenced by a document block. Use it before updating the object.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['object_id'],
        properties: {
          object_id: {
            type: 'string',
            description: 'Object id from a document placeholder.',
          },
        },
      },
      output: {
        schema: objectOutputSchema,
        render: (_args, value) => [text(JSON.stringify(value, null, 2))],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = asRecord(args);
        try {
          return await readObject(service, requireString(input, 'object_id'));
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Read document object', kind: 'read' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_object_update',
      description:
        'Replace the payload of one mindmap/component object. The document revision must be current; the object is immutable and the block reference is updated atomically.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['doc_id', 'block_id', 'base_revision', 'payload'],
        properties: {
          doc_id: { type: 'string' },
          block_id: { type: 'string' },
          base_revision: { type: 'integer' },
          payload: {
            type: 'object',
            additionalProperties: true,
            properties: {},
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'object_id', 'changed_block_ids'],
          properties: {
            revision: { type: 'integer' },
            object_id: { type: 'string' },
            changed_block_ids: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const result = value as {
            revision: number;
            object_id: string;
            changed_block_ids: string[];
          };
          return [
            text(
              `对象已更新为 ${result.object_id}，revision=${result.revision}，涉及块 ${result.changed_block_ids.length} 个。`,
            ),
          ];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const input = asRecord(args);
        try {
          const result = await service.updateObject({
            docId: requireString(input, 'doc_id'),
            blockId: requireString(input, 'block_id'),
            baseRevision: requireInteger(input, 'base_revision'),
            payload: input.payload as JsonValue,
          });
          return {
            revision: result.revision,
            object_id: result.objectId,
            changed_block_ids: result.changedBlockIds,
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Update document object', kind: 'edit' }),
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
