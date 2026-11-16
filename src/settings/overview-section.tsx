/**
 * "接入概览" section: one priority-ordered status line for the Space data
 * authority, each with exactly one next action.
 *
 * The overview is a read-only projection of the Host settings snapshot plus the
 * live migration job state; it never keeps its own copy of the authority. The
 * state order mirrors the deployment design: migration in flight → connection
 * misconfigured → offline → unsettled writes → connected → local (not
 * configured / saved but unverified / verified and ready to migrate).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@alter/ui-system';
import { SettingsSection } from './section';
import type {
  SpaceMigrationState,
  SpaceSettingsClient,
  SpaceSettingsSnapshot,
} from '../client/rpc.js';
import {
  describeError,
  formatClock,
  formatTimestamp,
  hostOf,
  migrationPercent,
  migrationPhaseLabel,
  type SettingsFocusTarget,
} from './shared.js';
import styles from './settings.module.css';

/** Tone token shared with the server section's connection dot. */
type OverviewTone = 'active' | 'attention' | 'error' | 'offline' | 'ok' | 'muted';

interface OverviewAction {
  label: string;
  /** Focus a control in one of the sections below. */
  target?: SettingsFocusTarget;
  /** Probe the saved server URL instead of moving focus. */
  probe?: boolean;
}

/** One rendered status: key, tone, copy and its single next step. */
interface OverviewModel {
  key: string;
  tone: OverviewTone;
  text: string;
  detail?: string;
  action?: OverviewAction;
  secondary?: { label: string; target: SettingsFocusTarget };
}

const EMPTY_MODEL: OverviewModel = {
  key: 'loading',
  tone: 'muted',
  text: '正在读取服务器与同步状态…',
};

/**
 * Project the Host snapshot plus the migration job onto the priority ladder.
 * Pure so the section render stays declarative and tests can reason about it.
 * @param snapshot - shared settings snapshot, or null while loading.
 * @param migration - live migration job, or null when none/unknown.
 */
export function overviewState(
  snapshot: SpaceSettingsSnapshot | null,
  migration: SpaceMigrationState | null,
): OverviewModel {
  if (migration?.status === 'running') {
    const direction =
      migration.direction === 'from-server'
        ? '正在把服务器数据迁移回本地'
        : '正在把本地数据迁移到服务器';
    const percent = migrationPercent(migration);
    const phase = migrationPhaseLabel(migration.phase);
    return {
      key: 'migrating',
      tone: 'active',
      text: [direction, percent === null ? null : `${String(percent)}%`, phase]
        .filter((part): part is string => part !== null)
        .join(' · '),
      action: { label: '查看进度', target: 'migration' },
    };
  }
  if (snapshot === null) return EMPTY_MODEL;

  const host = hostOf(snapshot.serverUrl);
  if (snapshot.mode === 'server') {
    const connection = snapshot.connection;
    if (connection.state === 'error')
      return {
        key: 'config-error',
        tone: 'error',
        text: `连接配置错误：${connection.message ?? '请检查服务器地址与设备 token'}`,
        detail:
          snapshot.serverUrl === null
            ? '还没有保存服务器地址'
            : `服务器地址：${snapshot.serverUrl}`,
        action: { label: '更新 token', target: 'server-token' },
      };
    if (connection.state === 'offline')
      return {
        key: 'offline',
        tone: 'offline',
        text: `服务端离线，编辑先保存在本机（${String(
          snapshot.sync.pendingWrites,
        )} 条待同步）`,
        ...(connection.message === undefined
          ? {}
          : { detail: connection.message }),
        action: { label: '重试连接', probe: true },
      };
    if (snapshot.sync.failed > 0 || snapshot.sync.conflicts > 0)
      return {
        key: 'unsettled',
        tone: 'attention',
        text: `${String(
          snapshot.sync.failed + snapshot.sync.conflicts,
        )} 篇文档的修改需要处理`,
        detail: `提交失败 ${String(snapshot.sync.failed)} · 与服务端冲突 ${String(
          snapshot.sync.conflicts,
        )}`,
        action: { label: '处理待同步写入', target: 'sync-queue' },
      };
    const synced = formatTimestamp(
      snapshot.sync.lastSyncedAt ?? connection.lastSyncedAt,
    );
    if (connection.state === 'connecting')
      return {
        key: 'connecting',
        tone: 'muted',
        text: `正在连接服务端${host === null ? '' : ` · ${host}`}…`,
        action: { label: '管理连接', target: 'server-url' },
      };
    return {
      key: 'online',
      tone: 'ok',
      text: `已连接 ${host ?? snapshot.serverUrl ?? '服务端'}${
        synced === null ? ' · 尚未同步' : ` · 上次同步 ${synced}`
      }`,
      action: { label: '管理连接', target: 'server-url' },
    };
  }

  // Local authority: the state machine's last three states.
  if (snapshot.serverUrl === null)
    return {
      key: 'local-unconfigured',
      tone: 'muted',
      text: '使用本地数据。想在多设备共享？可连接自部署服务器',
      action: { label: '配置服务器', target: 'server-url' },
    };
  // Verification is Host metadata (`settings.test` on the persisted target);
  // a session-local probe is only immediate feedback and never becomes state.
  if (snapshot.lastVerifiedAt === undefined)
    return {
      key: 'local-saved',
      tone: 'attention',
      text: '已保存服务器地址，尚未验证',
      detail: `服务器地址：${snapshot.serverUrl}`,
      action: { label: '测试连接', probe: true },
    };
  return {
    key: 'local-verified',
    tone: 'ok',
    text: `${host ?? snapshot.serverUrl} 可用；本地数据还没有迁过去`,
    detail: `最近验证 ${formatClock(snapshot.lastVerifiedAt) ?? '刚刚'}${
      snapshot.lastVerifiedVersion === undefined
        ? ''
        : ` · v${snapshot.lastVerifiedVersion}`
    }`,
    action: { label: '迁移到服务器', target: 'migration' },
    secondary: { label: '切换并放弃本地', target: 'mode-switch' },
  };
}

function toneClass(tone: OverviewTone): string {
  switch (tone) {
    case 'active':
      return styles.statusRunning;
    case 'attention':
      return styles.statusAttention;
    case 'error':
      return styles.statusError;
    case 'offline':
      return styles.statusOffline;
    case 'ok':
      return styles.statusOnline;
    case 'muted':
      return styles.statusLocal;
  }
}

export interface AccessOverviewSectionProps {
  /** Shared page snapshot; null while the first read is in flight. */
  snapshot: SpaceSettingsSnapshot | null;
  /** Live migration job polled by the page. */
  migration: SpaceMigrationState | null;
  /** Settings client used by the inline "测试连接" action. */
  client?: SpaceSettingsClient;
  /** Page-level snapshot refresh after a probe. */
  onRefresh?: () => void | Promise<void>;
  /** Move focus/scroll to a settings control below. */
  onGo: (target: SettingsFocusTarget) => void;
  /** Announce a status transition through the page's aria-live region. */
  onAnnounce?: (message: string) => void;
}

export function AccessOverviewSection({
  snapshot,
  migration,
  client,
  onRefresh,
  onGo,
  onAnnounce,
}: AccessOverviewSectionProps) {
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const model = overviewState(snapshot, migration);
  const action = model.action;
  const secondary = model.secondary;
  // Announce state transitions, not every progress tick: a running migration
  // updates its percentage each second and must not flood the live region.
  const announcedKey = useRef<string | null>(null);
  const announcedText = useRef<string | null>(null);
  useEffect(() => {
    const previousKey = announcedKey.current;
    const previousText = announcedText.current;
    announcedKey.current = model.key;
    announcedText.current = model.text;
    if (previousKey === null) return;
    if (previousKey !== model.key) onAnnounce?.(model.text);
    else if (
      model.key !== 'migrating' &&
      previousText !== null &&
      previousText !== model.text
    )
      onAnnounce?.(model.text);
  }, [model.key, model.text, onAnnounce]);

  async function probe(): Promise<void> {
    if (client === undefined || snapshot === null || snapshot.serverUrl === null)
      return;
    setTesting(true);
    setTestError('');
    try {
      const result = await client.test({ serverUrl: snapshot.serverUrl });
      if (result.ok) {
        // The Host records the probe (URL + stored token only); re-read the
        // snapshot so the verified state comes from Host metadata.
        await onRefresh?.();
        if (result.authenticated === true) {
          onAnnounce?.('连接成功，服务器可用');
        } else {
          // Reachable but unauthenticated: local mode still needs a stored
          // token before a migration, so point at the field instead of
          // claiming success (a server-mode retry can race a stale token).
          setTestError(
            '服务端可达，但还没有校验设备 token；请先保存 token 再测试',
          );
          onAnnounce?.('服务端可达，但尚未校验设备 token');
          if (snapshot.mode === 'local') onGo('server-token');
        }
      } else {
        setTestError(result.message ?? '连接失败');
        onAnnounce?.(`连接失败：${result.message ?? '未知错误'}`);
      }
    } catch (cause) {
      setTestError(describeError(cause, '请重试'));
      onAnnounce?.(`连接失败：${describeError(cause, '请重试')}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection id="settings-overview" title="接入概览">
      <div className={styles.rows} data-testid="access-overview" data-state={model.key}>
        <div className={`${styles.row} ${styles.rowSetting}`}>
          <span
            className={`${styles.overviewDot} ${toneClass(model.tone)}`}
            aria-hidden="true"
          />
          <span className={styles.rowText}>
            <span className={styles.overviewText}>{model.text}</span>
            {model.detail === undefined ? null : (
              <span className={styles.rowMeta}>{model.detail}</span>
            )}
          </span>
          {secondary === undefined && action === undefined ? null : (
            <span className={styles.inlineActions}>
              {secondary === undefined ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onGo(secondary.target)}
                >
                  {secondary.label}
                </Button>
              )}
              {action === undefined ? null : action.probe === true ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={testing || client === undefined}
                  onClick={() => void probe()}
                >
                  {testing ? '测试中…' : action.label}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    action.target === undefined
                      ? undefined
                      : onGo(action.target)
                  }
                >
                  {action.label}
                </Button>
              )}
            </span>
          )}
        </div>
        {testError === '' ? null : (
          <div className={styles.errorBar}>
            <span role="alert">{testError}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={testing}
              onClick={() => void probe()}
            >
              重新测试
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}