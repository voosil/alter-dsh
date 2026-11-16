/**
 * Space settings page.
 *
 * Replaces the reused `SettingsPage` composition: the reused page owned one
 * layout while the appended storage section owned
 * another, so the two columns collided and every section carried its own
 * explanatory copy. This page renders the settings of the whole Space feature
 * on one surface — the access overview, the two authority modes and their
 * migration, the DSH-only storage policy, archived space recovery, the
 * collaborator roster, keyboard shortcuts and about — in the same intro-column
 * grammar as the space configuration page.
 *
 * The page owns the shared settings snapshot and the migration job state: both
 * are polled once here and handed to the overview and the two sections, so the
 * whole surface agrees on one authority state instead of three independent
 * copies.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Archive } from 'lucide-react';
import { Button } from '@alter/ui-system';
import type { Agent, Space, SpaceService } from '@alter/protocol';
import { StorageSettingsSection } from './storage-section';
import { ServerSettingsSection } from './server-section';
import { MigrationSettingsSection } from './migration-section';
import { AccessOverviewSection } from './overview-section';
import { SettingsSection } from './section';
import { focusSettingsTarget } from './shared';
import type { SpaceStorageClient } from '../client/storage.js';
import type {
  SpaceMigrationClient,
  SpaceMigrationState,
  SpaceSettingsClient,
  SpaceSettingsSnapshot,
} from '../client/rpc.js';
import styles from './settings.module.css';

/** Keep in sync with package.json; shown as reference, not a feature surface. */
const APP_VERSION = 'Alter 0.1.0';
const ANNOUNCEMENT_MS = 2_400;
/** Shared settings snapshot poll; also the idle migration poll. */
const SNAPSHOT_POLL_MS = 5_000;
/** A running migration needs a faster progress tick. */
const MIGRATION_RUNNING_POLL_MS = 1_000;

function formatArchivedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
  }).format(new Date(value));
}

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export interface SpaceSettingsPageProps {
  service: SpaceService;
  /** Storage policy client; omitted only by tests that do not need it. */
  storage?: SpaceStorageClient;
  /** Server/mode settings client; omitted only by tests that do not need it. */
  settings?: SpaceSettingsClient;
  /** Migration client; omitted only by tests that do not need it. */
  migration?: SpaceMigrationClient;
  /** Return to the Space route the settings page was opened from. */
  onBack: () => void;
}

export function SpaceSettingsPage({
  service,
  storage,
  settings,
  migration,
  onBack,
}: SpaceSettingsPageProps) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [archivedSpaces, setArchivedSpaces] = useState<Space[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  /** Bumped by the retry control after a failed list read. */
  const [attempt, setAttempt] = useState(0);
  /** One shared authority snapshot for the overview, server and migration. */
  const [snapshot, setSnapshot] = useState<SpaceSettingsSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState('');
  /** Live migration job; the overview reports its phase while running. */
  const [migrationState, setMigrationState] =
    useState<SpaceMigrationState | null>(null);
  // Requests can resolve out of order; only the newest snapshot may win.
  const snapshotSeq = useRef(0);

  useEffect(() => {
    let active = true;
    void Promise.all([service.listAgents(), service.listArchivedSpaces()])
      .then(([nextAgents, nextArchived]) => {
        if (!active) return;
        setAgents(nextAgents);
        setArchivedSpaces(nextArchived);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadError(`读取失败：${describeError(cause, '请重试')}`);
        setAgents([]);
        setArchivedSpaces([]);
      });
    return () => {
      active = false;
    };
  }, [service, attempt]);

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    if (settings === undefined) return;
    const seq = ++snapshotSeq.current;
    try {
      const next = await settings.get();
      if (seq !== snapshotSeq.current) return;
      setSnapshot(next);
      setSnapshotError('');
    } catch (cause) {
      if (seq !== snapshotSeq.current) return;
      setSnapshotError(`读取服务器设置失败：${describeError(cause, '请重试')}`);
    }
  }, [settings]);

  useEffect(() => {
    if (settings === undefined) {
      setSnapshot(null);
      setSnapshotError('');
      return;
    }
    void refreshSnapshot();
    const timer = window.setInterval(() => {
      void refreshSnapshot();
    }, SNAPSHOT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [settings, refreshSnapshot]);

  const migrationRunning = migrationState?.status === 'running';

  useEffect(() => {
    if (migration === undefined) {
      setMigrationState(null);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const next = await migration.status();
        if (active) setMigrationState(next);
      } catch {
        // The overview keeps the last known state; settings reads report errors.
      }
    };
    void load();
    const timer = window.setInterval(
      () => void load(),
      migrationRunning ? MIGRATION_RUNNING_POLL_MS : SNAPSHOT_POLL_MS,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [migration, migrationRunning]);

  // A finished migration may have switched the authority; re-read the snapshot
  // now instead of waiting for the next poll tick.
  useEffect(() => {
    if (migrationState?.status !== 'done') return;
    void refreshSnapshot();
  }, [migrationState?.status, refreshSnapshot]);

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(
      () => setAnnouncement(''),
      ANNOUNCEMENT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [announcement]);

  function retryLists() {
    setLoadError('');
    setAgents(null);
    setArchivedSpaces(null);
    setAttempt((current) => current + 1);
  }

  async function restoreSpace(space: Space) {
    setRestoring(space.id);
    setRestoreError('');
    try {
      await service.unarchiveSpace(space.id);
      setArchivedSpaces((items) =>
        (items ?? []).filter((item) => item.id !== space.id),
      );
      setAnnouncement(`已恢复「${space.name}」`);
    } catch (cause) {
      setRestoreError(`恢复失败：${describeError(cause, '请重试')}`);
    } finally {
      setRestoring(null);
    }
  }

  const goTo = useCallback((target: Parameters<typeof focusSettingsTarget>[0]) => {
    focusSettingsTarget(target);
  }, []);

  const dataLocation =
    snapshot?.mode === 'server'
      ? `保存在 ${snapshot.serverUrl ?? '服务器'}`
      : '保存在本机';

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <Button
          size="sm"
          variant="ghost"
          className={styles.back}
          onClick={onBack}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          返回空间
        </Button>
      </header>

      <div className={styles.scroll}>
        <div className={styles.body}>
          <header className={styles.head}>
            <h1 className={styles.title}>设置</h1>
          </header>

          {loadError ? (
            <div className={styles.errorBar}>
              <span role="alert">{loadError}</span>
              <Button size="sm" variant="ghost" onClick={retryLists}>
                重试
              </Button>
            </div>
          ) : null}

          {snapshotError ? (
            <div className={styles.errorBar}>
              <span role="alert">{snapshotError}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void refreshSnapshot()}
              >
                重试
              </Button>
            </div>
          ) : null}

          <div className={styles.sections}>
            {settings ? (
              <AccessOverviewSection
                snapshot={snapshot}
                migration={migrationState}
                client={settings}
                onRefresh={refreshSnapshot}
                onGo={goTo}
                onAnnounce={setAnnouncement}
              />
            ) : null}
            {settings ? (
              <ServerSettingsSection
                client={settings}
                snapshot={snapshot}
                onSnapshotChange={setSnapshot}
                onRefresh={refreshSnapshot}
                migrationRunning={migrationRunning}
                onGoMigration={() => goTo('migration')}
              />
            ) : null}
            {migration ? (
              <MigrationSettingsSection
                client={migration}
                settings={settings}
                snapshot={settings === undefined ? undefined : snapshot}
                state={migrationState}
                onStateChange={setMigrationState}
                onRefreshSnapshot={refreshSnapshot}
                onGo={goTo}
              />
            ) : null}
            {storage ? <StorageSettingsSection storage={storage} /> : null}

            {loadError ? null : (
              <SettingsSection id="settings-archive" title="已归档空间">
                {archivedSpaces?.length ? (
                  <ul className={styles.rows}>
                    {archivedSpaces.map((space) => (
                      <li className={styles.row} key={space.id}>
                        <span className={styles.tile} aria-hidden="true">
                          <Archive size={15} strokeWidth={1.6} />
                        </span>
                        <span className={styles.rowText}>
                          <span className={styles.rowTitle}>{space.name}</span>
                          {space.archivedAt ? (
                            <span className={styles.rowMeta}>
                              {formatArchivedAt(space.archivedAt)}归档
                            </span>
                          ) : null}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={restoring === space.id}
                          onClick={() => void restoreSpace(space)}
                        >
                          {restoring === space.id ? '恢复中…' : '恢复'}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : archivedSpaces === null ? null : (
                  <p className={styles.empty}>没有已归档的空间。</p>
                )}
                {restoreError ? (
                  <p className={styles.error} role="alert">
                    {restoreError}
                  </p>
                ) : null}
              </SettingsSection>
            )}

            {loadError ? null : (
              <SettingsSection id="settings-agents" title="协作者">
                {agents?.length ? (
                  <ul className={styles.rows}>
                    {agents.map((agent) => (
                      <li className={styles.row} key={agent.id}>
                        <span className={styles.tile} aria-hidden="true">
                          {agent.name.slice(0, 1)}
                        </span>
                        <span className={styles.rowText}>
                          <span className={styles.rowTitle}>{agent.name}</span>
                          <span className={styles.rowMeta}>
                            {[agent.role, agent.model]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : agents === null ? null : (
                  <p className={styles.empty}>
                    还没有协作者。在空间详情 → 配置中新建。
                  </p>
                )}
              </SettingsSection>
            )}

            <SettingsSection id="settings-shortcuts" title="快捷键">
              <dl className={styles.rows}>
                <div className={`${styles.row} ${styles.rowCompact}`}>
                  <dt className={styles.rowLabel}>记录随想</dt>
                  <dd className={styles.keys}>
                    <kbd>⌘</kbd>
                    <kbd>E</kbd>
                  </dd>
                </div>
                <div className={`${styles.row} ${styles.rowCompact}`}>
                  <dt className={styles.rowLabel}>搜索当前空间</dt>
                  <dd className={styles.keys}>
                    <kbd>⌘</kbd>
                    <kbd>K</kbd>
                  </dd>
                </div>
              </dl>
            </SettingsSection>

            <SettingsSection id="settings-about" title="关于">
              <dl className={styles.rows}>
                <div className={`${styles.row} ${styles.rowCompact}`}>
                  <dt className={styles.rowLabel}>版本</dt>
                  <dd className={styles.rowValue}>{APP_VERSION}</dd>
                </div>
                <div className={`${styles.row} ${styles.rowCompact}`}>
                  <dt className={styles.rowLabel}>数据</dt>
                  <dd
                    className={`${styles.rowValue} ${styles.rowValueWrap}`}
                    data-testid="about-data-location"
                  >
                    {dataLocation}
                  </dd>
                </div>
              </dl>
            </SettingsSection>
          </div>
        </div>
      </div>

      <p
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        data-testid="settings-announcement"
      >
        {announcement}
      </p>
    </div>
  );
}