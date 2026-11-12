/**
 * Model-facing connection settings tool.
 *
 * Lets the Agent read the active authority mode/link status and, with the
 * user's approval, configure the self-hosted server URL/token or trigger a
 * queue flush. Sensitive writes require the DSH approval service; without an
 * answerer they fail closed instead of writing silently.
 *
 * @module @alter-dsh/space/control/agent-settings-tool
 */
import type { ConnectionAudit } from './connection-audit.js';
import {
  ConnectionSettingsError,
  normalizeServerUrl,
  type ConnectionSettingsStore,
} from './connection-settings.js';
import type { SpaceModeController } from '../core/mode.js';
import { STORAGE_LIMITS } from '../persistence/settings.js';
import { testRemoteServer } from '../remote/test.js';
import type {
  ToolDefinitionLike,
  ToolRunContextLike,
  ToolsLike,
} from '../document/editors/legacy/tools.js';
import { isPluginControlEndpoint } from '../authority/rpc.js';
import {
  applyConnectionPatch,
  type ConnectionPatchReview,
} from './settings-rpc.js';

/** DSH approval subset this tool needs. */
export interface ApprovalLike {
  request(request: {
    agent: unknown;
    toolName: string;
    callId?: unknown;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

/** Dependencies for the Agent settings tool. */
export interface AgentSettingsToolDeps {
  settings: ConnectionSettingsStore;
  mode: SpaceModeController;
  /** Local Space data directory (owns the per-server queue/cache files). */
  directory: string;
  audit: ConnectionAudit;
  /** Lazily resolves the approval service; may appear after registration. */
  approval?: () => ApprovalLike | undefined;
}

/** `historyLimit` → `history_limit` for messages written in the tool vocabulary. */
function snakeOf(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Whether a storage patch keeps fewer versions or snapshots than today.
 *
 * Lowering either limit deletes recovery points on the next write/snapshot, so
 * it is treated like the other sensitive changes and needs the user's approval;
 * raising a limit only adds recovery points.
 */
async function shrinksRecoveryWindow(
  current: Record<string, unknown> | null,
  patch: Record<string, number>,
): Promise<boolean> {
  if (current === null) return false;
  for (const [key, value] of Object.entries(patch)) {
    const before = current[key];
    if (typeof before === 'number' && value < before) return true;
  }
  return false;
}

async function storageOf(
  deps: AgentSettingsToolDeps,
): Promise<Record<string, unknown> | null> {
  try {
    const result = (await deps.mode.current().rpc('storage.get', {
      op: 'storage.get',
      args: [],
    })) as { value?: unknown; error?: unknown };
    if (result.error !== undefined) return null;
    const value = result.value as { settings?: unknown } | undefined;
    return value?.settings === undefined
      ? null
      : (value.settings as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Non-secret state the tool returns. */
async function stateOf(
  deps: AgentSettingsToolDeps,
): Promise<Record<string, unknown>> {
  const view = await deps.settings.view();
  const connection = deps.mode.status();
  return {
    storage: await storageOf(deps),
    mode: view.mode,
    serverUrl: view.serverUrl,
    tokenConfigured: view.tokenConfigured,
    updatedAt: view.updatedAt,
    connection: {
      state: connection.state,
      ...(connection.message === undefined
        ? {}
        : { message: connection.message }),
      ...(connection.serverVersion === undefined
        ? {}
        : { serverVersion: connection.serverVersion }),
      pendingWrites: connection.pendingWrites ?? 0,
      conflicts: connection.conflicts ?? 0,
    },
    capabilities: {
      remoteDirectories: view.mode === 'server',
      workspaceMapping: view.mode === 'local',
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Refuse writes while a migration owns the authority window. */
function assertMigrationIdle(deps: AgentSettingsToolDeps): void {
  const mode = deps.mode as Partial<SpaceModeController>;
  if (typeof mode.isMigrationLocked === 'function' && mode.isMigrationLocked())
    throw new ConnectionSettingsError(
      'migration/busy',
      '迁移进行中，不能修改服务器配置、存储策略或重放待同步写入',
    );
}

/** Approval reason for one sensitive settings change (never includes a token). */
function reviewReason(review: ConnectionPatchReview): string {
  const parts: string[] = [];
  if (review.modeChanged)
    parts.push(
      `把数据后端从${review.previousMode === 'server' ? '服务端' : '本地'}切换为${review.nextMode === 'server' ? '服务端' : '本地'}`,
    );
  if (review.serverUrlChanged)
    parts.push(
      `把服务器地址从 ${review.previousServerUrl ?? '未配置'} 改为 ${review.nextServerUrl ?? '未配置'}`,
    );
  if (review.tokenChanged) parts.push('写入或清除服务端 token');
  if (review.discard) parts.push('放弃旧服务端地址下尚未同步的本地写入');
  return `将修改 Space 服务器配置：${parts.join('；')}。这是敏感操作，可能改变空间数据的归属主机。`;
}

/**
 * Register `space_settings` on one Host tools service.
 * @returns disposer removing the registration.
 */
export function registerAgentSettingsTool(
  tools: ToolsLike,
  deps: AgentSettingsToolDeps,
): () => void {
  const definition: ToolDefinitionLike = {
    name: 'space_settings',
    description:
      'Read or change every Space business setting. action=get reports the current mode, server URL, token presence, link/queue status and the storage policy (history_limit/snapshot_keep). action=set switches between local mode and a self-hosted Space server (mode, server_url, token required for server mode) and can update storage settings via history_limit/snapshot_keep. Switching the authority mode (including switching back to local) and changing server_url/token are sensitive: every such change requires the user approval flow, never ask the user to paste a token into the conversation unless they chose to. A mode switch also requires discard=true to acknowledge that the authority being left is abandoned; changing server_url while the old server still has unsettled queued writes requires discard=true too, otherwise the change is rejected. action=test probes a server URL/token without saving. action=flush retries queued document writes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'test', 'flush'],
        },
        mode: {
          type: 'string',
          enum: ['local', 'server'],
          description: 'Target authority mode for action=set.',
        },
        server_url: {
          type: 'string',
          description: 'Self-hosted Space server base URL for action=set.',
        },
        token: {
          type: 'string',
          description:
            'Bearer token for action=set; write-only and never returned.',
        },
        clear_token: {
          type: 'boolean',
          description: 'Clear the stored token for action=set.',
        },
        discard: {
          type: 'boolean',
          description:
            'Explicitly acknowledge abandoning data. Required for any mode switch and for changing server_url while the old server still has unsettled queued writes; the change is rejected without it. Never set this on the user\'s behalf without their confirmation.',
        },
        history_limit: {
          type: 'integer',
          description: 'Storage setting: full versions kept per document (1-100).',
        },
        snapshot_keep: {
          type: 'integer',
          description: 'Storage setting: daily snapshots to keep (1-30).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContextLike) {
      const input = isPlainObject(args) ? args : {};
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        if (action === 'get') return await stateOf(deps);
        if (action === 'flush') {
          assertMigrationIdle(deps);
          await deps.mode.flush();
          deps.audit.record({
            actor: 'agent',
            action: 'sync',
            result: 'ok',
          });
          return await stateOf(deps);
        }
        if (action === 'test') {
          const view = await deps.settings.view();
          const explicitUrl =
            typeof input.server_url === 'string' &&
            input.server_url.trim() !== '';
          const rawUrl = explicitUrl ? input.server_url : view.serverUrl;
          if (typeof rawUrl !== 'string')
            throw new ConnectionSettingsError(
              'settings/invalid',
              '需要 server_url 才能测试连接',
            );
          const serverUrl = normalizeServerUrl(rawUrl);
          if (serverUrl === null)
            throw new ConnectionSettingsError(
              'settings/invalid',
              '需要 server_url 才能测试连接',
            );
          const targetsConfiguredServer =
            view.serverUrl !== null && serverUrl === view.serverUrl;
          // Probing a model-supplied URL is a network action the user did not
          // request: require approval, and never send the resident token to a
          // host the user did not configure (prompt-injection token theft).
          if (!targetsConfiguredServer) {
            const approval = deps.approval?.();
            if (approval === undefined)
              throw new ConnectionSettingsError(
                'settings/approval-required',
                '测试其他服务器地址需要用户确认；当前宿主没有审批服务',
              );
            const outcome = await approval.request({
              agent: exec.agent,
              toolName: exec.name,
              callId: exec.callId,
              reason: `将向模型指定的服务器地址 ${serverUrl} 发起连接测试`,
              signal: exec.signal,
            });
            if (outcome !== 'allowed-once') {
              deps.audit.record({
                actor: 'agent',
                action: 'test',
                from: serverUrl,
                result: 'rejected',
              });
              throw new Error(`用户未批准测试该服务器地址（${outcome}）`);
            }
          }
          const loaded = await deps.settings.load();
          const explicitToken =
            typeof input.token === 'string' && input.token.trim() !== '';
          const token = explicitToken
            ? (input.token as string).trim()
            : targetsConfiguredServer
              ? loaded.token
              : undefined;
          const result = await testRemoteServer({
            serverUrl,
            ...(token === undefined ? {} : { token }),
          });
          deps.audit.record({
            actor: 'agent',
            action: 'test',
            from: serverUrl,
            result: result.ok ? 'ok' : 'failed',
          });
          return result;
        }
        if (action !== 'set')
          throw new ConnectionSettingsError(
            'settings/invalid',
            'action 必须是 get、set、test 或 flush',
          );
        const storagePatch: Record<string, number> = {};
        if (input.history_limit !== undefined) {
          if (
            typeof input.history_limit !== 'number' ||
            !Number.isInteger(input.history_limit)
          )
            throw new ConnectionSettingsError(
              'settings/invalid',
              'history_limit 必须是整数',
            );
          storagePatch.historyLimit = input.history_limit;
        }
        if (input.snapshot_keep !== undefined) {
          if (
            typeof input.snapshot_keep !== 'number' ||
            !Number.isInteger(input.snapshot_keep)
          )
            throw new ConnectionSettingsError(
              'settings/invalid',
              'snapshot_keep 必须是整数',
            );
          storagePatch.snapshotKeep = input.snapshot_keep;
        }
        // The Host validates these again, but a rejected value only surfaces as
        // a bare error; checking the same bounds here keeps the model inside the
        // range and says which value is wrong.
        for (const [key, bounds] of Object.entries(STORAGE_LIMITS)) {
          const value = storagePatch[key];
          if (value === undefined) continue;
          if (value < bounds.min || value > bounds.max)
            throw new ConnectionSettingsError(
              'settings/invalid',
              `${snakeOf(key)} 必须在 ${bounds.min}–${bounds.max} 之间，收到 ${String(value)}`,
            );
        }
        // One shared helper owns the migration lock, the mode-switch/
        // unsettled-queue guards, approval, backend switch/rollback and audit
        // for both the settings page and this tool.
        await applyConnectionPatch(
          {
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.server_url === undefined
              ? {}
              : { serverUrl: input.server_url }),
            ...(input.clear_token === true
              ? { token: null }
              : typeof input.token === 'string'
                ? { token: input.token }
                : {}),
            ...(input.discard === true ? { discard: true } : {}),
          },
          {
            settings: deps.settings,
            mode: deps.mode,
            directory: deps.directory,
            actor: 'agent',
            audit: deps.audit,
            approval: async (review) => {
              const approval = deps.approval?.();
              if (approval === undefined)
                throw new ConnectionSettingsError(
                  'settings/approval-required',
                  '修改服务器配置需要用户在设置页确认；当前宿主没有审批服务',
                );
              return approval.request({
                agent: exec.agent,
                toolName: exec.name,
                callId: exec.callId,
                reason: reviewReason(review),
                signal: exec.signal,
              });
            },
          },
        );
        if (Object.keys(storagePatch).length > 0) {
          assertMigrationIdle(deps);
          // Keeping fewer snapshots deletes recovery points. That is the same
          // class of change as a mode switch, so it goes through the same
          // approval; raising the limit only adds recovery points and needs no
          // gate.
          if (await shrinksRecoveryWindow(await storageOf(deps), storagePatch)) {
            const approval = deps.approval?.();
            if (approval === undefined)
              throw new ConnectionSettingsError(
                'settings/approval-required',
                '降低版本历史或每日快照的保留数量会删除现有恢复点；当前宿主没有审批服务',
              );
            const outcome = await approval.request({
              agent: exec.agent,
              toolName: exec.name,
              callId: exec.callId,
              reason: `将降低版本历史或每日快照的保留数量（${JSON.stringify(storagePatch)}），这会删除现有恢复点`,
              signal: exec.signal,
            });
            if (outcome !== 'allowed-once') {
              deps.audit.record({
                actor: 'agent',
                action: 'test',
                result: 'rejected',
              });
              throw new Error(`用户未批准降低恢复点保留数量（${outcome}）`);
            }
          }
          const stored = (await deps.mode.current().rpc('storage.set', {
            op: 'storage.set',
            args: [storagePatch],
          })) as { error?: { message?: string } };
          if (stored.error !== undefined)
            throw new Error(stored.error.message ?? '保存存储设置失败');
        }
        return await stateOf(deps);
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
    presentCall() {
      return {
        card: 'generic',
        title: 'Space server settings',
        kind: 'read',
      };
    },
  };
  return tools.register(definition);
}

/** Re-export for tests that assert the control-plane split. */
export { isPluginControlEndpoint };
