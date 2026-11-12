/**
 * Model-facing Agent tool for generic Space file imports.
 *
 * `space_import_file` stores arbitrary file bytes as a content-addressed asset
 * and returns its id for later reference; images keep their dedicated
 * `space_asset_import` tool with its own (smaller) size limit. The import goes
 * through the authority's `doc.importFile` endpoint, so the local and server
 * authority modes share one write path.
 *
 * @module @alter-dsh/space/authority/import-tools
 */
import type {
  JsonSchemaLike,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import {
  asRecord,
  optionalString,
  requireString,
  text,
  toToolError,
} from './tool-support.js';
import type { RpcToolDeps } from './tool-support.js';

/** Public fields the authority returns for one file import. */
interface ImportedFile {
  assetId: string;
  mime: string;
  bytes: number;
  name?: string;
}

/** Permissive output shape, same convention as the other tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

/**
 * Register `space_import_file` on one Host tools service.
 * @param tools - Host tools service.
 * @param deps - alter-bound endpoint caller plus the approval resolver.
 * @returns disposer that removes the registration.
 */
export function registerImportTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: 'space_import_file',
      description:
        'Import a generic file asset into the Space asset store and return its asset id, stored mime type and byte size. Use the id to reference the file later; bytes are content-addressed and deduplicated. This is for non-image files — import images with space_asset_import instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['mime', 'data_base64'],
        properties: {
          mime: {
            type: 'string',
            description:
              'File media type, e.g. text/plain or application/pdf.',
          },
          data_base64: {
            type: 'string',
            description: 'Base64-encoded file bytes (max 8 MiB decoded).',
          },
          name: { type: 'string', description: 'Optional display name.' },
        },
      },
      output: {
        schema: outputSchema,
        render: (_args, value) => {
          const result = value as {
            asset_id?: unknown;
            mime?: unknown;
            bytes?: unknown;
            name?: unknown;
          };
          const name =
            typeof result.name === 'string' ? `《${result.name}》` : '';
          return [
            text(
              `文件已导入${name}：${String(result.asset_id ?? '')}（${String(result.mime ?? '')}，${String(result.bytes ?? 0)} 字节）。`,
            ),
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          const input = asRecord(args);
          const name = optionalString(input, 'name');
          const result = (await deps.rpc('doc.importFile', [
            {
              mime: requireString(input, 'mime'),
              dataBase64: requireString(input, 'data_base64'),
              ...(name === undefined ? {} : { name }),
            },
          ])) as ImportedFile;
          return {
            asset_id: result.assetId,
            mime: result.mime,
            bytes: result.bytes,
            ...(result.name === undefined ? {} : { name: result.name }),
          };
        } catch (error) {
          throw toToolError(error);
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Import Space file',
        kind: 'edit',
      }),
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}