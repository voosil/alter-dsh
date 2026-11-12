/**
 * "数据迁移" section: moves the whole Space dataset between the local
 * authority and a self-hosted server after an explicit preflight.
 */
import { useEffect, useState } from 'react';
import { Button } from '@alter/ui-system';
import { SettingsSection } from './section';
import type {
  SpaceMigrationClient,
  SpaceMigrationDirection,
  SpaceMigrationPreflight,
  SpaceMigrationState,
} from '../client/rpc.js';
import styles from './settings.module.css';

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 || value >= 10
    ? `${Math.round(value)} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

export interface MigrationSettingsSectionProps {
  client: SpaceMigrationClient;
}

export function MigrationSettingsSection({
  client,
}: MigrationSettingsSectionProps) {
  const [direction, setDirection] = useState<SpaceMigrationDirection>('to-server');
  const [preflight, setPreflight] = useState<SpaceMigrationPreflight | null>(null);
  const [state, setState] = useState<SpaceMigrationState | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [trimHistory, setTrimHistory] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const running = state?.status === 'running';

  useEffect(() => {
    let active = true;
    void client
      .status()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void client
        .status()
        .then((next) => setState(next))
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [running, client]);

  async function check(nextDirection: SpaceMigrationDirection): Promise<void> {
    setDirection(nextDirection);
    setChecking(true);
    setError('');
    setPreflight(null);
    try {
      const result = await client.preflight(nextDirection);
      setPreflight(result);
      setOverwrite(false);
      setConfirmReplace(false);
    } catch (cause) {
      setError(`预检失败：${describeError(cause, '请重试')}`);
    } finally {
      setChecking(false);
    }
  }

  async function start(): Promise<void> {
    setStarting(true);
    setError('');
    try {
      const next = await client.start({
        direction,
        overwrite,
        trimHistory,
      });
      setState(next);
      setPreflight(null);
      // The starting direction and its confirmations must not survive the run:
      // leaving them set let the next click start a transfer with the previous
      // acknowledgement already ticked.
      setOverwrite(false);
      setConfirmReplace(false);
      setTrimHistory(false);
    } catch (cause) {
      setError(`启动失败：${describeError(cause, '请重试')}`);
    } finally {
      setStarting(false);
    }
  }

  async function cancel(): Promise<void> {
    try {
      setState(await client.cancel());
    } catch (cause) {
      setError(`取消失败：${describeError(cause, '请重试')}`);
    }
  }

  const percent =
    state !== null &&
    state.totalBytes !== null &&
    state.totalBytes > 0 &&
    running
      ? Math.min(100, Math.round((state.transferredBytes / state.totalBytes) * 100))
      : null;

  return (
    <SettingsSection id="settings-migration" title="数据迁移">
      <div className={styles.rows}>
        <p className={styles.meta}>
          两种模式不会自动同步。迁移会先导出快照、校验后再切换；失败不会改变当前权威数据。
        </p>

        {preflight === null && !running ? (
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="secondary"
              disabled={checking}
              onClick={() => void check('to-server')}
            >
              {checking && direction === 'to-server'
                ? '预检中…'
                : '把本地数据迁移到服务器'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={checking}
              onClick={() => void check('from-server')}
            >
              {checking && direction === 'from-server'
                ? '预检中…'
                : '把服务器数据迁回本地'}
            </Button>
          </div>
        ) : null}

        {preflight !== null && !running ? (
          <div className={styles.rows}>
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>本地数据</span>
              <span className={styles.rowValue}>
                {formatBytes(preflight.local.databaseBytes)} 数据库 ·{' '}
                {formatBytes(preflight.local.assetBytes)} 资产（
                {preflight.local.assetCount} 个）
              </span>
            </div>
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>
                {direction === 'from-server' ? '服务端（数据源）' : '服务端'}
              </span>
              <span className={styles.rowValue}>
                {preflight.server.reachable
                  ? direction === 'from-server'
                    ? preflight.server.empty
                      ? '空库：迁回后本地也会是空数据'
                      : '有数据，将覆盖本地'
                    : preflight.server.empty
                      ? '空库，可直接接收'
                      : '已有数据，需要确认覆盖'
                  : preflight.server.message ?? '不可达'}
              </span>
            </div>
            {direction === 'to-server' && preflight.needsOverwrite ? (
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(event) => setOverwrite(event.target.checked)}
                />
                <span className={styles.rowText}>
                  覆盖服务端现有数据（服务端会先备份）
                </span>
              </label>
            ) : null}
            {direction === 'to-server' && preflight.overwriteDropsServerData ? (
              <p className={styles.errorBar} role="alert">
                服务端的数据比本地多：覆盖后服务端多出的文档、评论或版本只会留在服务端备份里，
                迁移完成前请先确认是否需要先在服务端导出。
              </p>
            ) : null}
            {direction === 'to-server' ? (
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={trimHistory}
                  onChange={(event) => setTrimHistory(event.target.checked)}
                />
                <span className={styles.rowText}>
                  只迁移每篇文档的最新版本（会丢历史，需确认）
                </span>
              </label>
            ) : null}
            {direction === 'from-server' ? (
              <>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={confirmReplace}
                    onChange={(event) =>
                      setConfirmReplace(event.target.checked)
                    }
                  />
                  <span className={styles.rowText}>
                    我确认用服务端快照替换本地库（本地原有文件会先备份到
                    `.migration/backup-*`）
                  </span>
                </label>
                <p className={styles.meta}>
                  迁回前会先确认本地没有未同步到服务端的写入；存在待同步或冲突的写入时会拒绝迁移。
                </p>
              </>
            ) : null}
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPreflight(null)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={
                  starting ||
                  !preflight.ok ||
                  (direction === 'to-server' &&
                    preflight.needsOverwrite &&
                    !overwrite) ||
                  (direction === 'from-server' && !confirmReplace)
                }
                onClick={() => void start()}
              >
                {starting ? '启动中…' : '开始迁移'}
              </Button>
            </div>
          </div>
        ) : null}

        {state !== null && state.status !== 'idle' ? (
          <div className={styles.rows}>
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>状态</span>
              <span className={styles.rowValue}>
                {running
                  ? '迁移中…'
                  : state.status === 'done'
                    ? '完成'
                    : state.status === 'failed'
                      ? '失败'
                      : '已取消'}
                {state.phase ? ` · ${state.phase}` : ''}
              </span>
            </div>
            {running ? (
              <>
                <div className={styles.progress}>
                  <div
                    className={styles.progressBar}
                    style={{ width: percent === null ? '12%' : `${String(percent)}%` }}
                  />
                </div>
                <p className={styles.meta}>
                  {state.message ?? '处理中…'}
                  {state.totalBytes !== null
                    ? ` · ${formatBytes(state.transferredBytes)} / ${formatBytes(state.totalBytes)}`
                    : ''}
                </p>
                <div className={styles.actions}>
                  <Button size="sm" variant="ghost" onClick={() => void cancel()}>
                    取消迁移
                  </Button>
                </div>
              </>
            ) : state.error ? (
              <div className={styles.errorBar}>
                <span role="alert">{state.error}</span>
              </div>
            ) : (
              <p className={styles.meta}>{state.message ?? '迁移结束'}</p>
            )}
          </div>
        ) : null}

        {error ? (
          <div className={styles.errorBar}>
            <span role="alert">{error}</span>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
