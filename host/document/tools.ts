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
import type { DocumentAssets } from './assets.js';
import type {
  ApplyOperationsInput,
  DocumentService,
} from './service.js';
import { COMPONENT_CATALOG } from '../../vendor/protocol/src/components.js';

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
  /** Optional asset store; absent disables space_asset_import. */
  assets?: DocumentAssets;
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

/** A string argument that may be empty (e.g. `new_text: ''` deletes text). */
function requireAnyString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') invalid(`${key} 必须是字符串`);
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

/** Stable document error code of a thrown value, when it carries one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Add the next actionable step to a `space_doc_patch` failure.
 *
 * The patch tool is the model's first-class exact-edit path, so every common
 * failure must say what to do next instead of only echoing the error code.
 */
function patchErrorMessage(error: unknown): string {
  const base = errorMessage(error);
  switch (errorCode(error)) {
    case 'doc/conflict':
      return `${base}；base_revision 已过期：请重新 space_doc_read 或 space_doc_outline 获取最新 revision 后重试。`;
    case 'node/not-found':
      return `${base}；block_id 不存在或已被删除：请重新 space_doc_read 获取 blocks 后重试。`;
    case 'op/invalid': {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('歧义'))
        return `${base}；old_text 不唯一：请提供更长的 old_text，或设置 replace_all=true。`;
      if (message.includes('未命中'))
        return `${base}；old_text 与目标块当前文本不一致：请重新 space_doc_read 后原样复制该块纯文本（不含 Markdown 标记）。`;
      return `${base}；请检查 old_text/new_text 是否为目标块的纯文本。`;
    }
    case 'node/not-writable':
      return `${base}；目标不是可精确改写的 textblock：请改用 space_doc_ops 的 replace_block 或 update_attrs。`;
    case 'idempotency/conflict':
      return `${base}；该 idempotency_key 已用于不同内容：请换用新的 key，或重放完全相同的 patch。`;
    default:
      return base;
  }
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

function renderOps(args: unknown, value: unknown): ToolTextBlock[] {
  const input = args as { dry_run?: boolean };
  const result = value as {
    revision: number;
    changed_block_ids: string[];
    undo_token?: string;
  };
  const headline =
    input.dry_run === true
      ? `dry-run 预览（未写入 Host），revision=${result.revision}；将涉及块 ${result.changed_block_ids.length} 个。`
      : `已应用，revision=${result.revision}；涉及块 ${result.changed_block_ids.length} 个。`;
  return [
    text(
      [
        headline,
        result.undo_token === undefined ? '' : `undoToken=${result.undo_token}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ];
}

function renderPatch(args: unknown, value: unknown): ToolTextBlock[] {
  const input = args as { block_id?: string };
  const result = value as {
    revision: number;
    changed_block_ids: string[];
    dry_run?: boolean;
    undo_token?: string;
  };
  const target = input.block_id === undefined ? '目标块' : `block ${input.block_id}`;
  if (result.dry_run === true) {
    return [
      text(
        `patch 预览（未写入）：${target}，revision=${result.revision}，涉及块 ${result.changed_block_ids.length} 个。`,
      ),
    ];
  }
  return [
    text(
      [
        `已 patch ${target}，revision=${result.revision}；涉及块 ${result.changed_block_ids.length} 个。`,
        result.undo_token === undefined
          ? ''
          : `undoToken=${result.undo_token}；可用 space_doc_undo 撤销。`,
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

/** Public catalog entry returned by `space_component_catalog`. */
interface ComponentCatalogEntry {
  id: string;
  name: string;
  description: string;
  version: number;
  props: Record<string, JsonValue>;
  defaults: Record<string, JsonValue>;
  ai_writable: string[];
}

/** Project one built-in component definition into the snake_case tool contract. */
function componentCatalogEntry(
  definition: (typeof COMPONENT_CATALOG)[number],
): ComponentCatalogEntry {
  const props: Record<string, JsonValue> = {};
  for (const [key, spec] of Object.entries(definition.props)) {
    props[key] = {
      type: spec.type,
      label: spec.label,
      ...(spec.required === undefined ? {} : { required: spec.required }),
      ...(spec.maxLength === undefined ? {} : { max_length: spec.maxLength }),
      ...(spec.min === undefined ? {} : { min: spec.min }),
      ...(spec.max === undefined ? {} : { max: spec.max }),
      ...(spec.maxItems === undefined ? {} : { max_items: spec.maxItems }),
      ...(spec.itemMaxLength === undefined
        ? {}
        : { item_max_length: spec.itemMaxLength }),
    };
  }
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    props,
    defaults: definition.defaults,
    ai_writable: [...definition.aiWritable],
  };
}

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
 * Register the document tools on one Host tools service.
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
        'Read the block outline of one Space document (ids, types and short previews). Call this before reading or editing so you have stable block ids; outline ids are the block targets for space_doc_patch.',
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
        'Read one Space document as Markdown with block anchors; use block_ids/after/limit for long documents. The revision returned must be used as base_revision for writes, and blocks[].id values are the targets for space_doc_patch.',
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
        'Apply a batch of Document Operations to one Space document. Every operation targets a block id; the batch is atomic and requires the current base_revision from a read/outline. For update_text, edits[].oldText must be the plain text without Markdown marks (bold text **x** matches x). For a single exact text replacement prefer space_doc_patch; use this tool for multiple operations or structural changes.',
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
        render: (args, value) => renderOps(args, value),
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
      name: 'space_doc_patch',
      description:
        'Patch one exact text range in one text block. Read the block with space_doc_read (or space_doc_outline) first to get its id and the current revision, then pass old_text exactly as shown (plain text, no Markdown marks). Only the target text changes — never rewrite the whole document. Revert with space_doc_undo; use space_doc_ops for multiple or structural edits.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['doc_id', 'base_revision', 'block_id', 'old_text', 'new_text'],
        properties: {
          doc_id: { type: 'string', description: 'Document id.' },
          base_revision: {
            type: 'integer',
            description: 'Current revision from space_doc_read or space_doc_outline.',
          },
          block_id: {
            type: 'string',
            description:
              'Target textblock id from space_doc_read/outline/search.',
          },
          old_text: {
            type: 'string',
            description:
              'Exact plain text to replace (no Markdown marks). Must be unique in the block unless replace_all is set.',
          },
          new_text: {
            type: 'string',
            description: 'Replacement plain text; an empty string deletes the text.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence of old_text. Defaults to false.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Validate and diff without writing.',
          },
          idempotency_key: {
            type: 'string',
            description: 'Optional replay key; replaying it returns the original result.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'changed_block_ids', 'diff'],
          properties: {
            revision: { type: 'integer' },
            changed_block_ids: { type: 'array', items: { type: 'string' } },
            diff: { type: 'object', additionalProperties: true, properties: {} },
            undo_token: { type: 'string' },
            dry_run: { type: 'boolean' },
          },
        },
        render: (args, value) => renderPatch(args, value),
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const input = asRecord(args);
        try {
          const replaceAll = optionalBoolean(input, 'replace_all');
          const dryRun = optionalBoolean(input, 'dry_run');
          const idempotencyKey = optionalString(input, 'idempotency_key');
          const blockId = requireString(input, 'block_id');
          const ops: ApplyOperationsInput['ops'] = [
            {
              op: 'update_text',
              target: blockId,
              edits: [
                {
                  oldText: requireString(input, 'old_text'),
                  newText: requireAnyString(input, 'new_text'),
                  ...(replaceAll === true ? { replaceAll: true } : {}),
                },
              ],
            },
          ];
          const result = await service.applyOperations({
            docId: requireString(input, 'doc_id'),
            baseRevision: requireInteger(input, 'base_revision'),
            ops,
            ...(dryRun === undefined ? {} : { dryRun }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          });
          return {
            revision: result.revision,
            changed_block_ids: result.changedBlockIds,
            diff: result.diff as unknown as JsonValue,
            ...(dryRun === true || result.undoToken === undefined
              ? {}
              : { undo_token: result.undoToken }),
            ...(dryRun === true ? { dry_run: true } : {}),
          };
        } catch (error) {
          throw new Error(patchErrorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Patch document text', kind: 'edit' }),
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
      name: 'space_doc_undo',
      description:
        'Undo one previously applied Document Operations batch (the latest batch by default). The document revision must be current.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['doc_id', 'base_revision'],
        properties: {
          doc_id: { type: 'string', description: 'Document id.' },
          base_revision: {
            type: 'integer',
            description: 'Current revision from space_doc_read.',
          },
          undo_token: {
            type: 'string',
            description: 'Specific batch token; omit to undo the latest batch.',
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
        render: (args, value) => renderOps(args, value),
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const input = asRecord(args);
        try {
          const undoToken = optionalString(input, 'undo_token');
          const result = await service.undo({
            docId: requireString(input, 'doc_id'),
            baseRevision: requireInteger(input, 'base_revision'),
            ...(undoToken === undefined ? {} : { undoToken }),
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
        view({ card: 'generic', title: 'Undo document operations', kind: 'edit' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_asset_import',
      description:
        'Import a small image into the Space asset store and return its asset id. Use the id in an image block; bytes are content-addressed and deduplicated.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['mime', 'data_base64'],
        properties: {
          mime: {
            type: 'string',
            description: 'Image media type: image/png, image/jpeg, image/webp or image/gif.',
          },
          data_base64: {
            type: 'string',
            description: 'Base64-encoded image bytes (max 4 MiB decoded).',
          },
          name: { type: 'string', description: 'Optional display name.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['asset_id', 'mime', 'bytes'],
          properties: {
            asset_id: { type: 'string' },
            mime: { type: 'string' },
            bytes: { type: 'integer' },
            name: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const result = value as {
            asset_id: string;
            mime: string;
            bytes: number;
          };
          return [
            text(
              `资产已导入：${result.asset_id}（${result.mime}，${result.bytes} 字节）。`,
            ),
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const input = asRecord(args);
        try {
          if (deps.assets === undefined)
            throw new Error('object/invalid: 资产存储未启用');
          const mime = requireString(input, 'mime').toLowerCase();
          const encoded = requireString(input, 'data_base64');
          if (encoded.length > 6 * 1024 * 1024)
            throw new Error('object/invalid: 资产 base64 超过上限');
          const data = Buffer.from(encoded, 'base64');
          if (data.byteLength === 0) throw new Error('object/invalid: 资产内容为空');
          const record = await deps.assets.import({
            data: new Uint8Array(data),
            mime,
            ...(optionalString(input, 'name') === undefined
              ? {}
              : { name: optionalString(input, 'name') }),
          });
          return {
            asset_id: record.id,
            mime: record.mime,
            bytes: record.bytes,
            ...(record.name === undefined ? {} : { name: record.name }),
          };
        } catch (error) {
          throw new Error(errorMessage(error));
        }
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Import document asset', kind: 'edit' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_component_catalog',
      description:
        'List the built-in declarative component catalog: component ids, prop schemas, defaults and AI-writable props. Call this before inserting or updating a component; unknown components and props outside the catalog are rejected.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['components'],
          properties: {
            components: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {},
              },
            },
          },
        },
        render: (_args, value) => {
          const components = (
            value as { components: ComponentCatalogEntry[] }
          ).components;
          return [
            text(
              components
                .map(
                  (component) =>
                    `${component.id}（${component.name}，v${component.version}）：AI 可写 ${component.ai_writable.join('/') || '无'}`,
                )
                .join('\n'),
            ),
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute() {
        return {
          components: COMPONENT_CATALOG.map(componentCatalogEntry),
        };
      },
      presentCall: () =>
        view({ card: 'generic', title: 'Component catalog', kind: 'read' }),
    }),
  );

  disposers.push(
    tools.register({
      name: 'space_object_get',
      description:
        'Read the structured payload of a mindmap/component object referenced by a document block. Use it before updating the object; component payloads follow the catalog schema from space_component_catalog.',
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
        'Replace the payload of one mindmap/component object. The document revision must be current; the object is immutable and the block reference is updated atomically. For component objects the payload must match the catalog schema from space_component_catalog (`{ format:"alter-component/1", componentId, componentVersion, props }`); unknown components, unknown props, wrong types and out-of-range values fail closed.',
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
