/**
 * Model-facing migration tool.
 *
 * Wraps the same migration service the settings wizard uses. Starting a
 * migration requires the DSH approval flow because it replaces an entire
 * authority dataset; status/cancel/preflight are read-only or reversible.
 *
 * @module @alter-dsh/space/control/agent-migration-tool
 */
import type { ConnectionAudit } from './connection-audit.js';
import type { ApprovalLike } from './agent-settings-tool.js';
import type { ToolsLike, ToolDefinitionLike } from '../document/editors/legacy/tools.js';
import type {
  MigrationDirection,
  MigrationService,
} from './migration/service.js';

/** Dependencies for the Agent migration tool. */
export interface AgentMigrationToolDeps {
  migration: MigrationService;
  audit: ConnectionAudit;
  /** Lazily resolves the approval service; may appear after registration. */
  approval?: () => ApprovalLike | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function directionOf(value: unknown): MigrationDirection {
  if (value === 'to-server' || value === 'from-server') return value;
  throw new Error('direction 必须是 to-server 或 from-server');
}

/**
 * Register `space_migrate` on one Host tools service.
 * @returns disposer removing the registration.
 */
export function registerAgentMigrationTool(
  tools: ToolsLike,
  deps: AgentMigrationToolDeps,
): () => void {
  const definition: ToolDefinitionLike = {
    name: 'space_migrate',
    description:
      'Move the entire Space dataset between the local authority and the self-hosted server. action=preflight reports local/server data size and whether overwrite is needed. action=start begins a migration (direction=to-server|from-server; optional overwrite, trim_history) and requires user approval because it replaces an entire dataset. action=status reports progress and action=cancel aborts. The server address/token come from space_settings; configure them first. Do not start a migration without a preflight and the user confirmation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['preflight', 'start', 'status', 'cancel'],
        },
        direction: {
          type: 'string',
          enum: ['to-server', 'from-server'],
        },
        overwrite: {
          type: 'boolean',
          description:
            'Replace existing target data (server for to-server, local for from-server).',
        },
        trim_history: {
          type: 'boolean',
          description: 'Keep only the newest version per document when uploading.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = isPlainObject(args) ? args : {};
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        if (action === 'preflight') {
          const direction = directionOf(
            input.direction ?? deps.migration.status().direction,
          );
          return await deps.migration.preflight(direction);
        }
        if (action === 'status') return deps.migration.status();
        if (action === 'cancel') {
          deps.migration.cancel();
          return deps.migration.status();
        }
        if (action !== 'start')
          throw new Error('action 必须是 preflight、start、status 或 cancel');
        const direction = directionOf(input.direction);
        const approval = deps.approval?.();
        if (approval === undefined)
          throw new Error(
            '迁移需要用户确认；当前宿主没有审批服务，请在设置页手动迁移',
          );
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: `将迁移整个空间数据（${direction}），可能替换目标端的现有数据`,
          signal: exec.signal,
        });
        if (outcome !== 'allowed-once') {
          deps.audit.record({
            actor: 'agent',
            action: 'server',
            result: 'rejected',
          });
          throw new Error(`用户未批准迁移（${outcome}）`);
        }
        const state = await deps.migration.start({
          direction,
          overwrite: input.overwrite === true,
          trimHistory: input.trim_history === true,
        });
        deps.audit.record({
          actor: 'agent',
          action: 'server',
          result: 'ok',
        });
        return state;
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
    presentCall() {
      return {
        card: 'generic',
        title: 'Space data migration',
        kind: 'edit',
      };
    },
  };
  return tools.register(definition);
}
