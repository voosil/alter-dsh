/**
 * Orchestrates one migration job: resolves the server identity from connection
 * settings, freezes mutating calls around the final snapshot, runs the
 * transfer and switches the authority mode on success.
 *
 * @module @alter-dsh/space/control/migration/service
 */
import type { ConnectionSettingsStore } from '../connection-settings.js';
import { forceDailySnapshot } from '../../persistence/backup.js';
import { removeRemoteCache } from '../../remote/cache.js';
import type { SpaceModeController } from '../../core/mode.js';
import {
  createSpaceMigrationTransfer,
  type MigrationPreflight,
  type MigrationProgress,
} from './transfer.js';

/** Direction of one job. */
export type MigrationDirection = 'to-server' | 'from-server';

/** Request accepted by {@link MigrationService.start}. */
export interface MigrationStartInput {
  direction: MigrationDirection;
  overwrite?: boolean;
  trimHistory?: boolean;
}

/** Job state exposed through the RPC surface. */
export interface MigrationState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  direction?: MigrationDirection;
  phase?: string;
  message?: string;
  transferredBytes: number;
  totalBytes: number | null;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  counts?: unknown;
  backup?: string | null;
}

/** Migration service shared by the settings RPC and the Agent tool. */
export interface MigrationService {
  preflight(direction: MigrationDirection): Promise<MigrationPreflight>;
  start(input: MigrationStartInput): Promise<MigrationState>;
  status(): MigrationState;
  cancel(): void;
}

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
}

/** Options for one migration service. */
export interface MigrationServiceOptions {
  directory: string;
  settings: ConnectionSettingsStore;
  mode: SpaceModeController;
  now?: () => Date;
  logger?: LoggerLike;
  /** Resolves once every in-flight RPC write has finished (freeze barrier). */
  awaitDrain?: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function serverIdentity(
  settings: ConnectionSettingsStore,
): Promise<{ serverUrl: string; token: string }> {
  const loaded = await settings.load();
  const serverUrl = loaded.settings.serverUrl;
  const token = loaded.token;
  if (serverUrl === null || token === undefined)
    throw new Error('需要先在「服务器」设置里保存服务端地址与 token');
  return { serverUrl, token };
}

/**
 * Build one migration service.
 * @param options - data directory, settings and mode controller.
 */
export function createMigrationService(
  options: MigrationServiceOptions,
): MigrationService {
  const logger = options.logger ?? {};
  const now = options.now ?? (() => new Date());
  let state: MigrationState = {
    status: 'idle',
    transferredBytes: 0,
    totalBytes: null,
  };
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;

  function update(progress: MigrationProgress): void {
    state = {
      ...state,
      phase: progress.phase,
      message: progress.message,
      transferredBytes: progress.transferredBytes,
      totalBytes: progress.totalBytes,
    };
  }

  async function transferFor() {
    const { serverUrl, token } = await serverIdentity(options.settings);
    return createSpaceMigrationTransfer({
      directory: options.directory,
      serverUrl,
      token,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Whether the active authority matches the requested migration direction. */
  function directionProblem(
    direction: MigrationDirection,
  ): string | undefined {
    const kind = options.mode.current().kind;
    if (direction === 'to-server' && kind !== 'local')
      return '当前是服务端模式，不能把本地数据迁移到服务端；请先切回本地模式';
    if (direction === 'from-server' && kind !== 'server')
      return '当前是本地模式，不能从服务端迁回；请先在设置里切换到该服务端';
    return undefined;
  }

  async function run(input: MigrationStartInput): Promise<void> {
    const freeze = async (): Promise<void> => {
      options.mode.setMigrationLock(true);
      await options.awaitDrain?.();
    };
    // The server provides the freeze callback; we intentionally keep the lock
    // until the authority switch finishes so post-commit writes cannot land in
    // the old local database.
    const unfreeze = async (): Promise<void> => undefined;
    let previous:
      | { settings: { mode: 'local' | 'server'; serverUrl: string | null }; token: string | undefined }
      | undefined;
    let serverUrl: string | undefined;
    try {
      previous = await options.settings.load();
      const transfer = await transferFor();
      serverUrl = previous.settings.serverUrl ?? undefined;
      if (serverUrl === undefined)
        throw new Error('需要先在「服务器」设置里保存服务端地址与 token');
      if (input.direction === 'from-server') {
        // Pulling server data over the local database is only lossless when no
        // local edit still waits for the server: drain the queue first and
        // refuse to continue while anything is stuck.
        await options.mode.flush();
        const status = options.mode.current().status;
        const unsettled =
          (status.pendingWrites ?? 0) +
          (status.conflicts ?? 0) +
          (status.failed ?? 0);
        if (unsettled > 0)
          throw new Error(
            '存在尚未同步到服务端或需要处理的本地写入，请先恢复连接并处理后再迁移回本地',
          );
      }
      if (input.direction === 'to-server') {
        const result = await transfer.toServer({
          overwrite: input.overwrite === true,
          trimHistory: input.trimHistory === true,
          freeze,
          unfreeze,
          onProgress: update,
          signal: controller?.signal,
        });
        state = { ...state, phase: 'switch', message: '切换到服务端模式…' };
        // The server replaced its authority from this local snapshot: any
        // queue/cache left from an older server session must not replay.
        try {
          await removeRemoteCache(options.directory, serverUrl);
          const loaded = await options.settings.save({ mode: 'server' });
          await options.mode.apply(loaded);
        } catch (error) {
          // The server has already committed the new data. Roll it back so a
          // failed local switch cannot leave two authorities on different
          // data sets; if rollback fails the error names the server backup
          // for manual recovery.
          let recovery: string;
          try {
            await result.rollback();
            recovery = '已回滚服务端数据，服务端仍保持迁移前状态';
          } catch (rollbackError) {
            recovery = `服务端自动回滚失败（${errorMessage(
              rollbackError,
            )}）；服务端迁移前备份位于 ${
              result.serverBackup ?? '<dataDir>/.migration/backup-<id>'
            }，请手动恢复`;
          }
          await options.settings
            .save({
              mode: previous.settings.mode,
              serverUrl: previous.settings.serverUrl,
            })
            .catch(() => undefined);
          await options.settings.setToken(previous.token ?? null).catch(
            () => undefined,
          );
          throw new Error(
            `切换到服务端模式失败（${errorMessage(error)}）；${recovery}；当前权威仍为本地`,
          );
        }
        state = {
          ...state,
          status: 'done',
          phase: 'done',
          message: '本地数据已迁移到服务端并切换',
          counts: result.counts,
          backup: result.serverBackup,
          finishedAt: new Date().toISOString(),
        };
      } else {
        const result = await transfer.fromServer({
          freeze,
          unfreeze,
          onProgress: update,
          signal: controller?.signal,
        });
        state = { ...state, phase: 'switch', message: '切换到本地模式…' };
        try {
          const loaded = await options.settings.save({ mode: 'local' });
          await options.mode.apply(loaded);
        } catch (error) {
          await options.settings
            .save({
              mode: previous.settings.mode,
              serverUrl: previous.settings.serverUrl,
            })
            .catch(() => undefined);
          await options.settings.setToken(previous.token ?? null).catch(
            () => undefined,
          );
          throw new Error(
            `切换到本地模式失败（${errorMessage(error)}）；本地数据库已是服务端快照，原数据备份位于 ${
              result.localBackup ?? '<dataDir>/.migration/backup-*'
            }`,
          );
        }
        // The downloaded snapshot is now the local authority; the server-scoped
        // queue and read cache have served their purpose.
        await removeRemoteCache(options.directory, serverUrl);
        // A migration replaces the whole database; make sure the new authority
        // has an initial snapshot even if today already held one of the old
        // data (history is the recovery baseline).
        const local = options.mode.current().local;
        if (local !== undefined) {
          const outcome = await forceDailySnapshot({
            store: local.store,
            directory: options.directory,
            now,
            logger,
          }).catch((error: unknown) => {
            logger.warn?.(
              `[alter-dsh-space] 迁移后初始快照失败：${errorMessage(error)}`,
            );
            return undefined;
          });
          if (outcome?.status === 'failed')
            logger.warn?.(
              `[alter-dsh-space] 迁移后初始快照失败：${outcome.reason ?? '未知原因'}`,
            );
        }
        state = {
          ...state,
          status: 'done',
          phase: 'done',
          message: '服务端数据已迁移回本地并切换',
          counts: result.counts,
          finishedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      const aborted = controller?.signal.aborted === true;
      state = {
        ...state,
        status: aborted ? 'cancelled' : 'failed',
        phase: aborted ? 'cancelled' : 'failed',
        error: aborted ? '迁移已取消' : errorMessage(error),
        message: aborted ? '迁移已取消' : '迁移失败',
        finishedAt: new Date().toISOString(),
      };
      logger.warn?.(`[alter-dsh-space] 迁移失败：${errorMessage(error)}`);
    } finally {
      options.mode.setMigrationLock(false);
      controller = undefined;
      running = undefined;
    }
  }

  return {
    async preflight(direction) {
      const problem = directionProblem(direction);
      const preflight = await (await transferFor()).preflight();
      return problem === undefined
        ? { ...preflight, replacesLocal: direction === 'from-server' }
        : { ...preflight, ok: false, message: problem };
    },
    async start(input): Promise<MigrationState> {
      if (running !== undefined) throw new Error('已有迁移任务在进行中');
      if (input.direction !== 'to-server' && input.direction !== 'from-server')
        throw new Error('direction 必须是 to-server 或 from-server');
      const problem = directionProblem(input.direction);
      if (problem !== undefined) throw new Error(problem);
      controller = new AbortController();
      state = {
        status: 'running',
        direction: input.direction,
        phase: 'preflight',
        message: '开始迁移…',
        transferredBytes: 0,
        totalBytes: null,
        startedAt: new Date().toISOString(),
      };
      running = run(input);
      return { ...state };
    },
    status() {
      return { ...state };
    },
    cancel() {
      if (running === undefined) return;
      controller?.abort();
    },
  };
}
