/**
 * Capability ledger: the single source of truth for the Space operation surface.
 *
 * Every browser RPC endpoint has exactly one row declaring its read/write class
 * and its Agent exposure: either the tool (and action) that serves it, or a
 * short reason it is excluded. The parity gate in
 * `tests/integration/contract/agent-surface.test.ts` keeps this ledger, the
 * `rpc.ts` whitelists, the derived read classification and the registered Agent
 * tools from drifting apart.
 *
 * Conventions:
 * - Rows follow the `rpc.ts` whitelist order per group, so the read set derived
 *   here keeps the historical iteration order of `READ_ENDPOINTS`.
 * - `kind` classifies the endpoint itself: `read` never mutates, `destructive`
 *   removes or overwrites data and must require approval when exposed (soft
 *   deletes into the trash are `write`), `control` is the plugin control plane
 *   (settings/sync/migration) and never reaches an authority backend.
 * - Exclusion reasons name the delivery phase (P1–P4) or the invariant that
 *   keeps the endpoint unexposed; flipping a row is a deliberate surface change.
 * - Tools without an RPC endpoint live in {@link ENDPOINTLESS_TOOLS}.
 *   `space_doc_patch` is registered there as a single-block wrapper over
 *   `doc.applyOps` (one row = one mapping, so the wrapper is not a second
 *   mapping on the `doc.applyOps` row).
 * - This module is deliberately standalone data: it does not import `rpc.ts`,
 *   so the ledger ↔ whitelist parity check is not tautological.
 *
 * @module @alter-dsh/space/authority/capabilities
 */

/** How one endpoint touches authority state. */
export type CapabilityKind = 'read' | 'write' | 'destructive' | 'control';

/** One endpoint's classification and Agent exposure. */
export interface Capability {
  /** Fully qualified endpoint, e.g. `space.createNode`. */
  endpoint: string;
  kind: CapabilityKind;
  /** The Agent tool serving it, or a short Chinese exclusion reason. */
  agent: { tool: string; action?: string } | { excluded: string };
}

/** A registered Agent tool that has no RPC endpoint of its own. */
export interface EndpointlessTool {
  tool: string;
  /** Why the tool exists without an endpoint. */
  reason: string;
}

const P2_COMMENTS = 'P2 待建（评论）';
const P2_VERSIONS = 'P2 待建（版本历史）';
const P2_THOUGHTS = 'P2 待建（随想）';
const P3_GOVERNANCE = 'P3 待建（空间治理）';
const P3_COLLABORATORS = 'P3 待建（协作者）';
const P3_HUB_OVERVIEW = 'P3 待建（hub 概览）';
const P3_HUB_CONFIG = 'P3 待建（hub 配置）';
const HUB_MATTER = '未实现占位（事项），P3 待建';
const HUB_JOURNEY = '未实现占位（旅程），P3 待建';
const HUB_OBSERVATION = '未实现占位（观察），P3 待建';

/**
 * The full operation surface: 73 business endpoints + 11 control-plane
 * endpoints, in `rpc.ts` whitelist order per group.
 */
export const CAPABILITIES: readonly Capability[] = [
  // space.* — business
  { endpoint: 'space.listSpaces', kind: 'read', agent: { tool: 'space_browse', action: 'spaces' } },
  { endpoint: 'space.getSpace', kind: 'read', agent: { tool: 'space_browse', action: 'space' } },
  { endpoint: 'space.createSpace', kind: 'write', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.updateSpace', kind: 'write', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.archiveSpace', kind: 'write', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.unarchiveSpace', kind: 'write', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.listArchivedSpaces', kind: 'read', agent: { tool: 'space_browse', action: 'archived_spaces' } },
  { endpoint: 'space.deleteSpace', kind: 'destructive', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.reorderSpaces', kind: 'write', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.listNodes', kind: 'read', agent: { tool: 'space_browse', action: 'tree' } },
  { endpoint: 'space.getNode', kind: 'read', agent: { tool: 'space_browse', action: 'node' } },
  { endpoint: 'space.createNode', kind: 'write', agent: { tool: 'space_tree', action: 'create' } },
  // saveNode 仅元数据，正文走 doc 工具（space_tree rename 只传 title）。
  { endpoint: 'space.saveNode', kind: 'write', agent: { tool: 'space_tree', action: 'rename' } },
  { endpoint: 'space.moveNode', kind: 'write', agent: { tool: 'space_tree', action: 'move' } },
  { endpoint: 'space.setPinned', kind: 'write', agent: { tool: 'space_tree', action: 'pin' } },
  { endpoint: 'space.setArchived', kind: 'write', agent: { tool: 'space_tree', action: 'archive' } },
  // deleteNode 软删除进回收站（space_tree delete 可 restore）。
  { endpoint: 'space.deleteNode', kind: 'write', agent: { tool: 'space_tree', action: 'delete' } },
  { endpoint: 'space.restoreNode', kind: 'write', agent: { tool: 'space_tree', action: 'restore' } },
  {
    endpoint: 'space.recordOpen',
    kind: 'write',
    agent: { excluded: '不伪造用户活动度，永不暴露' },
  },
  { endpoint: 'space.listComments', kind: 'read', agent: { excluded: P2_COMMENTS } },
  { endpoint: 'space.addComment', kind: 'write', agent: { excluded: P2_COMMENTS } },
  { endpoint: 'space.updateComment', kind: 'write', agent: { excluded: P2_COMMENTS } },
  { endpoint: 'space.addCommentSupplement', kind: 'write', agent: { excluded: P2_COMMENTS } },
  { endpoint: 'space.deleteComment', kind: 'destructive', agent: { excluded: P2_COMMENTS } },
  { endpoint: 'space.resolveComment', kind: 'write', agent: { excluded: P2_COMMENTS } },
  { endpoint: 'space.listVersions', kind: 'read', agent: { excluded: P2_VERSIONS } },
  { endpoint: 'space.restoreVersion', kind: 'destructive', agent: { excluded: P2_VERSIONS } },
  { endpoint: 'space.listThoughts', kind: 'read', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.createThought', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.updateThought', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.setThoughtArchived', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.deleteThought', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.restoreThought', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.moveThought', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.convertThought', kind: 'write', agent: { excluded: P2_THOUGHTS } },
  { endpoint: 'space.listDeleted', kind: 'read', agent: { tool: 'space_browse', action: 'trash' } },
  { endpoint: 'space.emptyTrash', kind: 'destructive', agent: { excluded: P3_GOVERNANCE } },
  { endpoint: 'space.search', kind: 'read', agent: { tool: 'space_browse', action: 'search' } },
  { endpoint: 'space.getOverview', kind: 'read', agent: { tool: 'space_browse', action: 'overview' } },
  { endpoint: 'space.listAgents', kind: 'read', agent: { excluded: P3_COLLABORATORS } },
  { endpoint: 'space.createAgent', kind: 'write', agent: { excluded: P3_COLLABORATORS } },
  {
    endpoint: 'space.listDirectories',
    kind: 'read',
    agent: { excluded: 'P3 随空间治理暴露' },
  },
  // hub.* — business（概览/配置 P3 待建；事项/旅程/观察为未实现占位）
  { endpoint: 'hub.get', kind: 'read', agent: { excluded: P3_HUB_OVERVIEW } },
  { endpoint: 'hub.createMatter', kind: 'write', agent: { excluded: HUB_MATTER } },
  { endpoint: 'hub.setMatterStatus', kind: 'write', agent: { excluded: HUB_MATTER } },
  { endpoint: 'hub.answerMatter', kind: 'write', agent: { excluded: HUB_MATTER } },
  { endpoint: 'hub.readMatter', kind: 'write', agent: { excluded: HUB_MATTER } },
  { endpoint: 'hub.saveJourney', kind: 'write', agent: { excluded: HUB_JOURNEY } },
  { endpoint: 'hub.introduce', kind: 'write', agent: { excluded: HUB_JOURNEY } },
  { endpoint: 'hub.skipIntroduction', kind: 'write', agent: { excluded: HUB_JOURNEY } },
  { endpoint: 'hub.acceptObservation', kind: 'write', agent: { excluded: HUB_OBSERVATION } },
  { endpoint: 'hub.extractSkill', kind: 'write', agent: { excluded: HUB_OBSERVATION } },
  { endpoint: 'hub.setPolicy', kind: 'write', agent: { excluded: P3_HUB_CONFIG } },
  { endpoint: 'hub.setPluginEnabled', kind: 'write', agent: { excluded: P3_HUB_CONFIG } },
  { endpoint: 'hub.discoverPlugin', kind: 'write', agent: { excluded: P3_HUB_CONFIG } },
  { endpoint: 'hub.savePluginContent', kind: 'write', agent: { excluded: P3_HUB_CONFIG } },
  { endpoint: 'hub.summarize', kind: 'write', agent: { excluded: P3_HUB_OVERVIEW } },
  { endpoint: 'hub.remove', kind: 'write', agent: { excluded: P3_HUB_CONFIG } },
  // storage.* — business
  { endpoint: 'storage.get', kind: 'read', agent: { tool: 'space_settings', action: 'get' } },
  { endpoint: 'storage.estimate', kind: 'read', agent: { excluded: 'P4 待建（占用估算）' } },
  { endpoint: 'storage.set', kind: 'write', agent: { tool: 'space_settings', action: 'set' } },
  // doc.* — business
  {
    endpoint: 'doc.get',
    kind: 'read',
    agent: { excluded: '工具经 outline/read 投影读取，不暴露原始 AST' },
  },
  { endpoint: 'doc.outline', kind: 'read', agent: { tool: 'space_doc_outline' } },
  { endpoint: 'doc.read', kind: 'read', agent: { tool: 'space_doc_read' } },
  { endpoint: 'doc.search', kind: 'read', agent: { tool: 'space_doc_search' } },
  { endpoint: 'doc.applyOps', kind: 'write', agent: { tool: 'space_doc_ops' } },
  { endpoint: 'doc.undo', kind: 'write', agent: { tool: 'space_doc_undo' } },
  { endpoint: 'doc.restoreVersion', kind: 'destructive', agent: { excluded: P2_VERSIONS } },
  { endpoint: 'doc.generate', kind: 'write', agent: { tool: 'space_doc_generate' } },
  { endpoint: 'doc.importAsset', kind: 'write', agent: { tool: 'space_asset_import' } },
  { endpoint: 'doc.importFile', kind: 'write', agent: { excluded: 'P2 待建（文件导入）' } },
  { endpoint: 'doc.updateObject', kind: 'write', agent: { tool: 'space_object_update' } },
  // object.* — business
  { endpoint: 'object.get', kind: 'read', agent: { tool: 'space_object_get' } },
  // settings.* — control plane
  { endpoint: 'settings.get', kind: 'control', agent: { tool: 'space_settings', action: 'get' } },
  { endpoint: 'settings.update', kind: 'control', agent: { tool: 'space_settings', action: 'set' } },
  { endpoint: 'settings.test', kind: 'control', agent: { tool: 'space_settings', action: 'test' } },
  // sync.* — control plane
  { endpoint: 'sync.status', kind: 'control', agent: { tool: 'space_settings', action: 'get' } },
  { endpoint: 'sync.flush', kind: 'control', agent: { tool: 'space_settings', action: 'flush' } },
  { endpoint: 'sync.queue', kind: 'control', agent: { excluded: 'P4 待建（队列明细）' } },
  { endpoint: 'sync.resolve', kind: 'control', agent: { excluded: 'P4 待建（冲突处置）' } },
  // migration.* — control plane
  { endpoint: 'migration.preflight', kind: 'control', agent: { tool: 'space_migrate', action: 'preflight' } },
  { endpoint: 'migration.start', kind: 'control', agent: { tool: 'space_migrate', action: 'start' } },
  { endpoint: 'migration.status', kind: 'control', agent: { tool: 'space_migrate', action: 'status' } },
  { endpoint: 'migration.cancel', kind: 'control', agent: { tool: 'space_migrate', action: 'cancel' } },
];

/**
 * Registered Agent tools without an RPC endpoint. The parity gate accepts a
 * captured tool definition when the ledger references it or it appears here.
 *
 * `space_doc_patch` wraps `doc.applyOps` as a single-block `update_text`
 * replacement; it has no endpoint of its own, and one ledger row carries one
 * mapping, so the wrapper is registered here instead of doubling the
 * `doc.applyOps` row.
 */
export const ENDPOINTLESS_TOOLS: readonly EndpointlessTool[] = [
  {
    tool: 'space_component_catalog',
    reason: '直接读内置组件目录（vendor/protocol），无 RPC 端点',
  },
  {
    tool: 'space_doc_patch',
    reason: 'doc.applyOps 的单块封装（一次 update_text），无独立端点',
  },
];

/** Look up one endpoint's ledger row. */
export function getCapability(endpoint: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.endpoint === endpoint);
}

/** Every ledger row whose Agent mapping targets one tool. */
export function endpointsForTool(tool: string): readonly Capability[] {
  return CAPABILITIES.filter(
    (capability) =>
      'tool' in capability.agent && capability.agent.tool === tool,
  );
}

/** Flattened endpoint → tool/action mappings, for tool registration wiring. */
export function agentMappings(): ReadonlyArray<{
  endpoint: string;
  tool: string;
  action?: string;
}> {
  const mappings: Array<{ endpoint: string; tool: string; action?: string }> = [];
  for (const capability of CAPABILITIES) {
    if (!('tool' in capability.agent)) continue;
    mappings.push({
      endpoint: capability.endpoint,
      tool: capability.agent.tool,
      ...(capability.agent.action === undefined
        ? {}
        : { action: capability.agent.action }),
    });
  }
  return mappings;
}

/**
 * Business endpoints that never mutate the authority. Control-plane rows are
 * `kind: 'control'`, so filtering on `read` alone yields exactly the business
 * read set; row order preserves the historical `READ_ENDPOINTS` iteration.
 */
export function businessReadEndpoints(): ReadonlySet<string> {
  return new Set(
    CAPABILITIES.filter((capability) => capability.kind === 'read').map(
      (capability) => capability.endpoint,
    ),
  );
}