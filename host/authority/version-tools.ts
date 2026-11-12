/**
 * Model-facing Agent tools for Space document version history.
 *
 * `space_versions` lists the bounded version metadata of one document and
 * restores an earlier snapshot through the document-model endpoint. Restore
 * replaces the current body (the pre-restore body is kept as a version), so it
 * requires the current revision as `base_revision` and explicit user approval;
 * without an approval service the tool fails closed.
 *
 * @module @alter-dsh/space/authority/version-tools
 */
import type { DocVersion } from '@alter/protocol';
import type {
  JsonSchemaLike,
  ToolRunContextLike,
  ToolTextBlock,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import type { RpcToolDeps } from './tool-support.js';
import {
  approveDestructive,
  asRecord,
  invalid,
  optionalInteger,
  requireAction,
  requireString,
  text,
  toToolError,
} from './tool-support.js';

const VERSION_ACTIONS = ['list', 'restore'] as const;

type VersionAction = (typeof VERSION_ACTIONS)[number];

/** One listing never returns more than this many versions. */
const LIST_LIMIT = 30;

/** Bounded projection of one version; the stored body never crosses over. */
interface VersionView {
  id: string;
  title: string;
  author: string;
  at: string;
  bytes: number;
}

/** What `doc.restoreVersion` returns for one successful restore. */
interface RestoreResultLike {
  revision: number;
  changedBlockIds: string[];
}

/** Permissive multi-action output shape, same convention as the other tools. */
const outputSchema: JsonSchemaLike = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};

/** Project one stored version into its bounded metadata view. */
function versionView(version: DocVersion): VersionView {
  return {
    id: version.id,
    title: version.title,
    author: version.author,
    at: version.at,
    // The snapshot content is an `alter-doc/1` JSON document; only its size is
    // exposed so a listing stays bounded and never returns whole bodies.
    bytes: Buffer.byteLength(version.content, 'utf8'),
  };
}

/** Whether one action only reads; read actions are concurrency safe. */
function isReadAction(args: unknown): boolean {
  return (
    typeof args === 'object' &&
    args !== null &&
    (args as Record<string, unknown>).action === 'list'
  );
}

function renderVersions(args: unknown, value: unknown): ToolTextBlock[] {
  const input = args as { action?: VersionAction } | null;
  const result = value as Record<string, unknown>;

  if (Array.isArray(result.versions)) {
    const versions = result.versions as VersionView[];
    const header = `文档 ${String(result.doc_id)} 的版本历史：共 ${String(result.total)} 个（新→旧）${
      result.truncated === true
        ? `，仅返回前 ${versions.length} 个（truncated）`
        : ''
    }`;
    return [
      text(
        versions.length === 0
          ? `${header}（无）`
          : [
              header,
              ...versions.map(
                (version) =>
                  `- ${version.id}《${version.title || '未命名'}》 ${version.author} · ${version.at} · ${version.bytes}B`,
              ),
            ].join('\n'),
      ),
    ];
  }
  if (typeof result.revision === 'number' && input?.action === 'restore')
    return [
      text(
        `已恢复到版本 ${String(result.version_id)}，revision=${result.revision}；恢复前的正文已保留为历史版本，可用 space_versions list 查看。`,
      ),
    ];
  return [text(JSON.stringify(value))];
}

/** List the bounded version history of one document. */
async function listVersions(
  deps: RpcToolDeps,
  docId: string,
): Promise<unknown> {
  const versions = (await deps.rpc('space.listVersions', [
    docId,
  ])) as DocVersion[];
  return {
    doc_id: docId,
    total: versions.length,
    truncated: versions.length > LIST_LIMIT,
    versions: versions.slice(0, LIST_LIMIT).map(versionView),
  };
}

/** Restore one earlier version after approval, advancing the revision. */
async function restoreVersion(
  deps: RpcToolDeps,
  exec: ToolRunContextLike,
  input: Record<string, unknown>,
  docId: string,
): Promise<unknown> {
  const versionId = requireString(input, 'version_id');
  const baseRevision = optionalInteger(input, 'base_revision', { min: 0 });
  if (baseRevision === undefined)
    invalid(
      'action=restore 需要 base_revision（当前文档 revision，来自 space_doc_read 或 space_doc_outline）',
    );
  await approveDestructive(
    deps,
    exec,
    `恢复历史版本会替换当前正文（恢复前的正文会先存为历史版本，可在版本历史中找回）；确认把文档 ${docId} 恢复到版本 ${versionId}？`,
  );
  const result = (await deps.rpc('doc.restoreVersion', [
    { docId, versionId, baseRevision },
  ])) as RestoreResultLike;
  return {
    doc_id: docId,
    version_id: versionId,
    revision: result.revision,
    changed_block_ids: result.changedBlockIds,
  };
}

/**
 * Register the Space version-history tool on one Host tools service.
 * @param tools - Host tools service the definition is installed on.
 * @param deps - alter-bound RPC seam plus the lazy approval resolver.
 * @returns disposer that removes every registration.
 */
export function registerVersionTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: 'space_versions',
      description:
        "List one document's version history or restore an earlier version. Restore replaces the current body (the pre-restore body is kept as a version) and needs user approval; pass the current revision from space_doc_read as base_revision.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'doc_id'],
        properties: {
          action: {
            type: 'string',
            enum: [...VERSION_ACTIONS],
            description: 'Version operation to apply.',
          },
          doc_id: {
            type: 'string',
            description: 'Document id (from a Space listing or search).',
          },
          version_id: {
            type: 'string',
            description: 'restore: target version id; required.',
          },
          base_revision: {
            type: 'integer',
            description:
              'restore: current document revision; required (read it first).',
          },
        },
      },
      output: {
        schema: outputSchema,
        render: (args, value) => renderVersions(args, value),
      },
      isConcurrencySafe: (args) => isReadAction(args),
      async execute(args, exec) {
        try {
          const input = asRecord(args);
          const action = requireAction(input, VERSION_ACTIONS);
          const docId = requireString(input, 'doc_id');
          switch (action) {
            case 'list':
              return await listVersions(deps, docId);
            case 'restore':
              return await restoreVersion(deps, exec, input, docId);
          }
        } catch (error) {
          throw toToolError(error);
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Document version history',
        kind: 'edit',
      }),
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}