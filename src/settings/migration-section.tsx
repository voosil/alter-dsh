/**
 * "数据迁移" section: moves the whole Space dataset between the local
 * authority and a self-hosted server after an explicit preflight.
 *
 * Only the direction that the current authority permits is offered; the other
 * direction gets one explanatory line instead of a button. A failed preflight
 * renders the Host's `message` together with a way to fix the connection, and
 * the three irreversible choices (overwrite, trim history, discard) each need
 * an explicit acknowledgement before the transfer starts.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@alter/ui-system';
import { SettingsSection } from './section';
import type {
  SpaceMigrationClient,
  SpaceMigrationDirection,
  SpaceMigrationPreflight,
  SpaceMigrationState,
  SpaceSettingsClient,
  SpaceSettingsSnapshot,
} from '../client/rpc.js';
import {
  describeError,
  focusSettingsTarget,
  formatBytes,
  migrationPercent,
  migrationPhaseLabel,
  type SettingsFocusTarget,
} from './shared.js';
import styles from './settings.module.css';

/** Keep the standalone snapshot fallback in step with the page poll. */
const SNAPSHOT_POLL_MS = 5_000;
/** A running transfer reports progress continuously. */
const PROGRESS_POLL_MS = 1_000;

/** Chinese labels for the business rows a transfer reports. */
const COUNT_LABELS: Record<string, string> = {
  spaces: '空间',
  nodes: '文档',
  thoughts: '随想',
  comments: '评论',
  versions: '版本',
  assets: '资产',
  events: '动态',
  agents: '协作者',
  tasks: '任务',
  milestones: '里程碑',
  hub: '概览',
};

function formatCounts(counts: Record<string, number> | undefined): string | null {
  if (counts === undefined) return null;
  const parts: string[] = [];
  for (const [key, label] of Object.entries(COUNT_LABELS)) {
    const value = counts[key];
    if (typeof value === 'number' && value > 0) parts.push(`${label} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function directionLabel(direction: SpaceMigrationDirection | undefined): string {
  return direction === 'from-server' ? '服务端 → 本地' : '本地 → 服务端';
}

export interface MigrationSettingsSectionProps {
  client: SpaceMigrationClient;
  /** Shared page snapshot; omitted for standalone use. */
  snapshot?: SpaceSettingsSnapshot | null;
  /** Settings client used only by the standalone snapshot fallback. */
  settings?: SpaceSettingsClient;
  /** Page-owned live job state; when provided the section does not poll. */
  state?: SpaceMigrationState | null;
  onStateChange?: (next: SpaceMigrationState) => void;
  /** Ask the page for a fresh snapshot after the authority switched. */
  onRefreshSnapshot?: () => void | Promise<void>;
  /** Scroll/focus another settings control (fix entries). */
  onGo?: (target: SettingsFocusTarget) => void;
}

export function MigrationSettingsSection({
  client,
  snapshot: sharedSnapshot,
  settings,
  state: sharedState,
  onStateChange,
  onRefreshSnapshot,
  onGo,
}: MigrationSettingsSectionProps) {
  const controlled = onStateChange !== undefined;
  const [ownSnapshot, setOwnSnapshot] = useState<SpaceSettingsSnapshot | null>(
    null,
  );
  const snapshot = sharedSnapshot !== undefined ? sharedSnapshot : ownSnapshot;
  const [ownState, setOwnState] = useState<SpaceMigrationState | null>(null);
  const state = controlled ? sharedState ?? null : ownState;
  const [direction, setDirection] = useState<SpaceMigrationDirection>('to-server');
  const [preflight, setPreflight] = useState<SpaceMigrationPreflight | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [trimHistory, setTrimHistory] = useState(false);
  const [confirmTrim, setConfirmTrim] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  // Remember which terminal status was already cleaned up, so a snapshot
  // refresh does not re-trigger the cleanup on every render.
  const handledStatus = useRef<string | null>(null);

  const running = state?.status === 'running';
  const legalDirection: SpaceMigrationDirection | null =
    snapshot === null
      ? null
      : snapshot.mode === 'server'
        ? 'from-server'
        : 'to-server';

  // Only the direction matching the current authority may be offered.
  useEffect(() => {
    if (legalDirection !== null) setDirection(legalDirection);
  }, [legalDirection]);

  // Standalone fallback: read (and poll) the snapshot only when the page does
  // not pass one. The page owns polling in the composed settings page.
  useEffect(() => {
    if (sharedSnapshot !== undefined || settings === undefined) return;
    let active = true;
    const load = async () => {
      try {
        const next = await settings.get();
        if (active) setOwnSnapshot(next);
      } catch {
        // The page-level snapshot error is the user-facing read failure.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), SNAPSHOT_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sharedSnapshot, settings]);

  useEffect(() => {
    if (controlled) return;
    let active = true;
    void client
      .status()
      .then((next) => {
        if (active) setOwnState(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, controlled]);

  useEffect(() => {
    if (controlled || !running) return;
    let active = true;
    const timer = window.setInterval(() => {
      void client
        .status()
        .then((next) => {
          if (active) setOwnState(next);
        })
        .catch(() => undefined);
    }, PROGRESS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, controlled, running]);

  function applyState(next: SpaceMigrationState): void {
    if (controlled) onStateChange?.(next);
    else setOwnState(next);
  }

  // A finished job leaves no startable form behind: drop the old preflight and
  // every acknowledgement so the next attempt starts from a clean panel.
  useEffect(() => {
    const status = state?.status ?? null;
    if (status === 'running' || status === 'idle' || status === null) {
      handledStatus.current = null;
      return;
    }
    if (handledStatus.current === status) return;
    handledStatus.current = status;
    setPreflight(null);
    setOverwrite(false);
    setTrimHistory(false);
    setConfirmTrim(false);
    setConfirmReplace(false);
    if (status !== 'done') return;
    // The Host switched the authority; ask for the new mode/server URL.
    if (controlled) return;
    if (sharedSnapshot === undefined && settings !== undefined) {
      void settings
        .get()
        .then((next) => setOwnSnapshot(next))
        .catch(() => undefined);
    } else {
      void onRefreshSnapshot?.();
    }
  }, [state?.status, controlled, sharedSnapshot, settings, onRefreshSnapshot]);

  function go(target: SettingsFocusTarget): void {
    if (onGo !== undefined) onGo(target);
    else focusSettingsTarget(target);
  }

  async function check(nextDirection: SpaceMigrationDirection): Promise<void> {
    if (legalDirection === null || nextDirection !== legalDirection) return;
    if (running) return;
    setDirection(nextDirection);
    setChecking(true);
    setError('');
    setPreflight(null);
    try {
      const result = await client.preflight(nextDirection);
      setPreflight(result);
      setOverwrite(false);
      setConfirmReplace(false);
      setTrimHistory(false);
      setConfirmTrim(false);
    } catch (cause) {
      setError(`预检失败：${describeError(cause, '请重试')}`);
    } finally {
      setChecking(false);
    }
  }

  async function start(): Promise<void> {
    if (preflight === null || !preflight.ok || starting || running) return;
    setStarting(true);
    setError('');
    try {
      const next = await client.start({
        direction,
        overwrite,
        trimHistory: trimHistory && confirmTrim,
      });
      applyState(next);
      setPreflight(null);
      // The starting direction and its confirmations must not survive the run:
      // leaving them set let the next click start a transfer with the previous
      // acknowledgement already ticked.
      setOverwrite(false);
      setConfirmReplace(false);
      setTrimHistory(false);
      setConfirmTrim(false);
    } catch (cause) {
      setError(`启动失败：${describeError(cause, '请重试')}`);
    } finally {
      setStarting(false);
    }
  }

  async function cancel(): Promise<void> {
    try {
      applyState(await client.cancel());
    } catch (cause) {
      setError(`取消失败：${describeError(cause, '请重试')}`);
    }
  }

  function retry(): void {
    // The authority may have switched since the failed attempt: prefer the
    // direction the current mode actually allows.
    const next = legalDirection ?? state?.direction ?? direction;
    void check(next);
  }

  const percent = migrationPercent(state);
  const phaseLabel = migrationPhaseLabel(state?.phase);
  const counts = formatCounts(state?.counts);
  const overwriteWarning =
    direction === 'to-server' && preflight?.overwriteDropsServerData === true;
  // The Host returns a reason for a failed preflight; keep the local-database
  // case readable too instead of showing a generic failure.
  const preflightFailure =
    preflight?.message ??
    (preflight !== null &&
    direction === 'to-server' &&
    preflight.local.databaseBytes <= 0
      ? '本地还没有可迁移的数据；先在本地空间里创建内容或检查数据目录。'
      : '预检未通过，请先修复连接后重试');
  const startBlockedReason =
    preflight === null || preflight.ok === false
      ? null
      : direction === 'to-server' && preflight.needsOverwrite && !overwrite
        ? '需要先勾选覆盖服务端数据'
        : direction === 'to-server' && trimHistory && !confirmTrim
          ? '需要先确认丢弃历史版本'
          : direction === 'from-server' && !confirmReplace
            ? '需要先确认用服务端快照替换本地'
            : null;

  return (
    <SettingsSection id="settings-migration" title="数据迁移">
      <div
        className={`${styles.rows} ${styles.focusTarget}`}
        data-settings-target="migration"
        tabIndex={-1}
        data-testid="migration-section"
      >
        <div className={`${styles.row} ${styles.rowCompact}`}>
          <span className={styles.rowLabel}>当前数据位置</span>
          <span
            className={`${styles.rowValue} ${styles.rowValueWrap}`}
            data-testid="migration-authority"
          >
            {snapshot === null
              ? '读取中…'
              : snapshot.mode === 'server'
                ? snapshot.serverUrl ?? '服务器'
                : '本地'}
          </span>
        </div>

        <p className={styles.meta}>
          两种模式不会自动同步。迁移会先导出快照、校验后再切换；失败不会改变当前权威数据。
        </p>

        {running ? (
          <p className={styles.rowHint} data-testid="migration-running-hint">
            迁移进行中，服务器设置与迁移方向暂不可修改。
          </p>
        ) : null}

        {preflight === null && !running ? (
          legalDirection === null ? (
            <p className={styles.rowHint}>正在读取当前数据位置…</p>
          ) : (
            <>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="secondary"
                  data-settings-target="migration-direction"
                  disabled={checking || starting}
                  onClick={() => void check(legalDirection)}
                >
                  {checking
                    ? '预检中…'
                    : legalDirection === 'to-server'
                      ? '把本地数据迁移到服务器'
                      : '把服务器数据迁回本地'}
                </Button>
              </div>
              <p className={styles.rowHint} data-testid="migration-direction-hint">
                {legalDirection === 'to-server'
                  ? '当前是本地模式，不能从服务端迁回；请先在「服务器」切换到该服务端。'
                  : '当前是服务端模式，不能把本地数据迁移到服务器；请先切回本地模式。'}
              </p>
            </>
          )
        ) : null}

        {preflight !== null && !running ? (
          <div className={styles.rows} data-testid="preflight-panel">
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>本地数据</span>
              <span className={`${styles.rowValue} ${styles.rowValueWrap}`}>
                {formatBytes(preflight.local.databaseBytes)} 数据库 ·{' '}
                {formatBytes(preflight.local.assetBytes)} 资产（
                {preflight.local.assetCount} 个）
              </span>
            </div>
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>
                {direction === 'from-server' ? '服务端（数据源）' : '服务端'}
              </span>
              <span className={`${styles.rowValue} ${styles.rowValueWrap}`}>
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
            {preflight.ok === false ? (
              <div className={styles.errorBar} data-testid="preflight-failure">
                <span role="alert">{preflightFailure}</span>
                <span className={styles.inlineActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => go('server-url')}
                  >
                    去服务器区
                  </Button>
                  {/切回本地/.test(preflight.message ?? '') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => go('mode-switch')}
                    >
                      先切回本地
                    </Button>
                  ) : null}
                </span>
              </div>
            ) : null}
            {direction === 'to-server' && preflight.needsOverwrite ? (
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  disabled={starting}
                  onChange={(event) => setOverwrite(event.target.checked)}
                />
                <span className={styles.rowText}>
                  覆盖服务端现有数据（服务端会先备份）
                </span>
              </label>
            ) : null}
            {direction === 'from-server' ? (
              <>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={confirmReplace}
                    disabled={starting}
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
            {direction === 'to-server' ? (
              <>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={trimHistory}
                    disabled={starting}
                    onChange={(event) => {
                      setTrimHistory(event.target.checked);
                      if (!event.target.checked) setConfirmTrim(false);
                    }}
                  />
                  <span className={styles.rowText}>
                    只迁移每篇文档的最新版本（会丢历史，需确认）
                  </span>
                </label>
                {trimHistory ? (
                  <div
                    className={`${styles.row} ${styles.rowSetting} ${styles.confirmRow}`}
                    data-testid="trim-history-confirm"
                  >
                    <label className={styles.confirmLabel}>
                      <input
                        type="checkbox"
                        className={styles.confirmCheckbox}
                        checked={confirmTrim}
                        disabled={starting}
                        onChange={(event) =>
                          setConfirmTrim(event.target.checked)
                        }
                      />
                      <span>
                        我确认丢弃历史版本：迁移后每篇文档只剩最新版本，无法恢复。
                      </span>
                    </label>
                  </div>
                ) : null}
              </>
            ) : null}
            {overwriteWarning ? (
              <p className={styles.errorBar} role="alert">
                服务端的数据比本地多：覆盖后服务端多出的文档、评论或版本只会留在服务端备份里，
                迁移完成前请先确认是否需要先在服务端导出。
              </p>
            ) : null}
            <div className={`${styles.actions} ${styles.wrapActions}`}>
              {startBlockedReason === null ? null : (
                <span
                  className={styles.savedNote}
                  data-testid="migration-start-blocked"
                >
                  {startBlockedReason}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={starting}
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
                  (direction === 'to-server' && trimHistory && !confirmTrim) ||
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
          <div className={styles.rows} data-testid="migration-state">
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>状态</span>
              <span className={`${styles.rowValue} ${styles.rowValueWrap}`}>
                {running
                  ? `迁移中 · ${directionLabel(state.direction)}${
                      phaseLabel === null ? '' : ` · ${phaseLabel}`
                    }`
                  : state.status === 'done'
                    ? `完成 · ${directionLabel(state.direction)}`
                    : state.status === 'failed'
                      ? `失败 · ${directionLabel(state.direction)}`
                      : '已取消'}
                {percent === null ? '' : ` · ${String(percent)}%`}
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
            ) : state.status === 'failed' ? (
              <>
                <div className={styles.errorBar}>
                  <span role="alert">{state.error ?? '迁移失败'}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={checking}
                    onClick={retry}
                  >
                    重试
                  </Button>
                </div>
                <p className={styles.meta}>
                  迁移失败不会改变当前权威数据；修复上面的原因后可以重新预检。
                </p>
              </>
            ) : state.status === 'done' ? (
              <>
                <div className={styles.noticeBar} role="status">
                  <span>{state.message ?? '迁移完成'}</span>
                </div>
                {counts === null ? null : (
                  <p className={styles.meta} data-testid="migration-counts">
                    {counts}
                  </p>
                )}
                {state.backup === null || state.backup === undefined ? null : (
                  <p className={styles.meta} data-testid="migration-backup">
                    备份：{state.backup}
                  </p>
                )}
              </>
            ) : (
              <p className={styles.meta}>{state.message ?? '迁移已取消'}</p>
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