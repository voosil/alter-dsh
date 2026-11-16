/**
 * "服务器" section of the Space settings page.
 *
 * Selects the authority mode, edits the self-hosted server URL/token, probes
 * the link and shows queue/conflict state. Tokens are write-only from the
 * browser: the section only learns whether one is configured.
 *
 * Saving also probes the saved link ("保存并测试"), because a saved address the
 * user never reached is not a configured server. The section can read the
 * shared page snapshot or, when rendered on its own, load and poll one itself;
 * the page passes `onSnapshotChange` when it owns the snapshot.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@alter/ui-system';
import { SettingsSection } from './section';
import type {
  SpaceConnectionStatus,
  SpaceRemoteTestResult,
  SpaceSettingsClient,
  SpaceSettingsSnapshot,
  SpaceSyncQueueEntry,
} from '../client/rpc.js';
import { describeError, formatClock, formatTimestamp } from './shared.js';
import styles from './settings.module.css';

const STATUS_POLL_MS = 5_000;
const NOTICE_MS = 2_400;

/** Prompt copied by the "让 AI 配置" entry; matches the shipped deploy skill. */
const AI_SETUP_PROMPT =
  '请帮我部署并接通 Space 自部署服务端：使用本仓库的 Dockerfile/docker-compose 在服务器上启动 Space 服务（生成命名 token、挂载数据卷、跑健康检查），然后通过 space_settings 工具把当前插件切换到服务端模式并验证连接；需要我提供的信息一次问清，token 不要回显。如果要把现有本地空间迁过去，先备份再按迁移流程执行。';

/** One failure with the recovery the error bar offers. */
interface ActionError {
  text: string;
  action: 'token' | 'retry' | null;
}

function statusLabel(status: SpaceConnectionStatus): string {
  switch (status.state) {
    case 'local':
      return '本地模式';
    case 'connecting':
      return '正在连接服务端';
    case 'online':
      return '已连接服务端';
    case 'offline':
      return '服务端离线';
    case 'error':
      return '连接配置错误';
  }
}

function statusClass(status: SpaceConnectionStatus): string {
  switch (status.state) {
    case 'local':
      return styles.statusLocal;
    case 'connecting':
      return styles.statusPending;
    case 'online':
      return styles.statusOnline;
    case 'offline':
      return styles.statusOffline;
    case 'error':
      return styles.statusError;
  }
}

function queueStateLabel(state: SpaceSyncQueueEntry['state']): string {
  switch (state) {
    case 'pending':
      return '等待连接';
    case 'conflict':
      return '与服务端冲突';
    case 'failed':
      return '提交失败';
  }
}

function errorCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object' || !('code' in cause))
    return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Pick the recovery a thrown settings/sync failure can offer. */
function errorActionOf(cause: unknown): ActionError['action'] {
  const code = errorCode(cause);
  if (
    code === 'remote/unauthorized' ||
    code === 'settings/not-configured' ||
    code === 'settings/invalid'
  )
    return 'token';
  if (code === 'remote/unavailable') return 'retry';
  return null;
}

/** Pick the recovery a failed connection probe can offer. */
function testFailureAction(result: SpaceRemoteTestResult): ActionError['action'] {
  const message = result.message ?? '';
  if (/token|401|鉴权|未授权|unauthorized/i.test(message)) return 'token';
  if (/不可用|无法连接|超时|timeout|离线|offline|不可达/i.test(message))
    return 'retry';
  return null;
}

interface CountActionProps {
  value: number;
  label: string;
  onActivate: () => void;
}

/** A sync count that only becomes a control when there is something to see. */
function CountAction({ value, label, onActivate }: CountActionProps) {
  if (value <= 0)
    return (
      <span className={styles.rowMeta}>
        {value} 条{label}
      </span>
    );
  return (
    <button type="button" className={styles.countAction} onClick={onActivate}>
      {value} 条{label}
    </button>
  );
}

export interface ServerSettingsSectionProps {
  client: SpaceSettingsClient;
  /** Shared page snapshot; when omitted the section loads and polls its own. */
  snapshot?: SpaceSettingsSnapshot | null;
  /**
   * Present when the page owns the snapshot: the section then writes changes
   * up instead of polling, so overview/server never disagree.
   */
  onSnapshotChange?: (next: SpaceSettingsSnapshot) => void;
  /** Page-level snapshot refresh after a probe recorded by the Host. */
  onRefresh?: () => void | Promise<void>;
  /** True while a migration owns the authority: all authority edits lock. */
  migrationRunning?: boolean;
  /** Scroll to the migration section from the mode-switch confirmation. */
  onGoMigration?: () => void;
}

export function ServerSettingsSection({
  client,
  snapshot: sharedSnapshot,
  onSnapshotChange,
  onRefresh,
  migrationRunning = false,
  onGoMigration,
}: ServerSettingsSectionProps) {
  const urlId = useId();
  const tokenId = useId();
  const controlled = onSnapshotChange !== undefined;
  const [ownSnapshot, setOwnSnapshot] = useState<SpaceSettingsSnapshot | null>(
    null,
  );
  const snapshot = controlled ? sharedSnapshot ?? null : ownSnapshot;
  const [mode, setMode] = useState<'local' | 'server'>('local');
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearingToken, setClearingToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SpaceRemoteTestResult | null>(null);
  const [queue, setQueue] = useState<SpaceSyncQueueEntry[]>([]);
  const [resolving, setResolving] = useState('');
  const [bulkAction, setBulkAction] = useState<'retry' | 'discard' | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  // A real mode change abandons the authority on the side being left, so the
  // user has to confirm it explicitly instead of the page silently switching.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const mounted = useRef(true);
  // The poll timer is created once per client; a ref keeps it from writing a
  // stale `dirty=false` over fields the user is editing.
  const dirtyRef = useRef(false);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const tokenInput = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<HTMLDivElement | null>(null);
  const setDirtyState = (next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function applySnapshot(next: SpaceSettingsSnapshot): void {
    if (!mounted.current) return;
    if (controlled) onSnapshotChange?.(next);
    else setOwnSnapshot(next);
  }

  /** Re-read the snapshot so a Host-recorded probe becomes visible. */
  async function refreshAfterProbe(): Promise<void> {
    if (controlled) {
      await onRefresh?.();
      return;
    }
    try {
      const next = await client.get();
      if (mounted.current && !dirtyRef.current) setOwnSnapshot(next);
    } catch {
      // The probe result bar already reports the outcome.
    }
  }

  // The page pushes a fresh snapshot every few seconds; it must not overwrite a
  // draft the user is in the middle of editing.
  useEffect(() => {
    if (snapshot === null || dirtyRef.current) return;
    setMode(snapshot.mode);
    setServerUrl(snapshot.serverUrl ?? '');
  }, [snapshot]);

  // Standalone fallback: read and poll the snapshot only when the page does not
  // own it. A controlled section has no second source of truth.
  useEffect(() => {
    if (controlled) return;
    let active = true;
    const load = async () => {
      try {
        const next = await client.get();
        if (active) {
          setLoadError('');
          if (!dirtyRef.current) setOwnSnapshot(next);
        }
      } catch (cause) {
        if (active) setLoadError(`读取设置失败：${describeError(cause, '请重试')}`);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, controlled]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The queue is only meaningful while the server owns the data; a failed
  // poll keeps the last rows so the user can still act on them.
  async function refreshQueue(): Promise<void> {
    if (snapshot?.mode !== 'server') return;
    try {
      const entries = await client.syncQueue();
      if (mounted.current) setQueue(entries);
    } catch {
      // The status poll already surfaces link failures.
    }
  }

  const snapshotMode = snapshot?.mode ?? 'local';

  useEffect(() => {
    if (snapshotMode !== 'server') {
      setQueue([]);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const entries = await client.syncQueue();
        if (active) setQueue(entries);
      } catch {
        // Keep the last rows; the action bar shows the link failure.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, snapshotMode]);

  async function resolveEntry(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<void> {
    setResolving(docId);
    setActionError(null);
    try {
      const result = await client.resolveSync(docId, action);
      applySnapshot(result.state);
      setDiscardTarget(null);
      setNotice(
        action === 'retry'
          ? `已重新提交 ${String(result.resolved)} 条写入`
          : `已丢弃 ${String(result.resolved)} 条本地写入，内容以服务端为准`,
      );
      await refreshQueue();
    } catch (cause) {
      setActionError({
        text: `${action === 'retry' ? '重试' : '丢弃'}失败：${describeError(
          cause,
          '请重试',
        )}`,
        action: errorActionOf(cause),
      });
    } finally {
      setResolving('');
    }
  }

  /** Retry or discard every queued row, one Host call per document. */
  async function resolveMany(action: 'retry' | 'discard'): Promise<void> {
    const targets =
      action === 'retry'
        ? queue.filter((entry) => entry.state !== 'pending')
        : queue;
    if (targets.length === 0) return;
    setBulkAction(action);
    setActionError(null);
    let resolved = 0;
    let lastState: SpaceSettingsSnapshot | null = null;
    let failures = 0;
    for (const entry of targets) {
      try {
        const result = await client.resolveSync(entry.docId, action);
        resolved += result.resolved;
        lastState = result.state;
      } catch {
        failures += 1;
      }
    }
    if (lastState !== null) applySnapshot(lastState);
    setBulkAction(null);
    setConfirmDiscardAll(false);
    await refreshQueue();
    if (failures > 0) {
      setActionError({
        text: `${action === 'retry' ? '重试' : '丢弃'}完成：已处理 ${String(
          resolved,
        )} 条写入，${String(failures)} 篇失败，请重试`,
        action: 'retry',
      });
    } else {
      setNotice(
        action === 'retry'
          ? `已重新提交 ${String(resolved)} 条写入`
          : `已丢弃 ${String(resolved)} 条本地写入，内容以服务端为准`,
      );
    }
  }

  async function copySetupPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(AI_SETUP_PROMPT);
      setCopied(true);
      setNotice('配置指令已复制，粘贴到对话里即可让 AI 接管部署与配置');
      window.setTimeout(() => setCopied(false), NOTICE_MS);
    } catch {
      setActionError({
        text: '浏览器不允许写剪贴板，请手动复制部署说明',
        action: null,
      });
    }
  }

  function changeMode(next: 'local' | 'server') {
    setMode(next);
    setConfirmDiscard(false);
    setDirtyState(true);
    setActionError(null);
    setTestResult(null);
  }

  function changeUrl(value: string) {
    setServerUrl(value);
    setConfirmDiscard(false);
    setDirtyState(true);
    setActionError(null);
    setTestResult(null);
  }

  function changeToken(value: string) {
    setToken(value);
    setDirtyState(true);
    setActionError(null);
    setTestResult(null);
  }

  const effectiveUrl = serverUrl.trim();
  const urlValue = effectiveUrl === '' ? null : effectiveUrl;
  // The page may save a URL/token without changing the authority; only a real
  // mode change — or a server-URL change that would orphan unsettled queue
  // entries — needs the discard acknowledgement (and `discard: true`).
  const modeChanged = snapshot !== null && mode !== snapshot.mode;
  const urlChanged = snapshot !== null && urlValue !== snapshot.serverUrl;
  const queueNeedsDiscard =
    snapshotMode === 'server' && urlChanged && queue.length > 0;
  const needsDiscard = modeChanged || queueNeedsDiscard;
  const targetConfigured =
    effectiveUrl !== '' &&
    (snapshot?.tokenConfigured === true || token.trim() !== '');
  const canSave =
    !saving &&
    !migrationRunning &&
    (mode === 'local' || targetConfigured) &&
    (!needsDiscard || confirmDiscard);

  /** Why the primary button cannot run, shown next to it. */
  const saveBlockedReason: string | null = saving
    ? '正在保存…'
    : migrationRunning
      ? '迁移进行中'
      : mode === 'server' && effectiveUrl === ''
        ? '需要填写服务器地址'
        : mode === 'server' && !targetConfigured
          ? '需要填写设备 token'
          : needsDiscard && !confirmDiscard
            ? '需要先勾选确认'
            : null;

  /** One probe of a concrete URL. Returns null when the request itself threw. */
  async function runTest(
    targetUrl: string,
    enteredToken?: string,
  ): Promise<SpaceRemoteTestResult | null> {
    setTesting(true);
    setActionError(null);
    setTestResult(null);
    try {
      const result = await client.test({
        serverUrl: targetUrl,
        ...(enteredToken === undefined || enteredToken === ''
          ? {}
          : { token: enteredToken }),
      });
      setTestResult(result);
      // Only the Host can persist "verified"; it records probes of the saved
      // URL with the stored token, so re-read after every successful probe.
      if (result.ok) await refreshAfterProbe();
      return result;
    } catch (cause) {
      setActionError({
        text: `连接测试失败：${describeError(cause, '请重试')}`,
        action: errorActionOf(cause),
      });
      return null;
    } finally {
      setTesting(false);
    }
  }

  async function test(): Promise<void> {
    if (migrationRunning) return;
    const targetUrl =
      effectiveUrl !== '' ? effectiveUrl : snapshot?.serverUrl ?? '';
    if (targetUrl === '') {
      setActionError({ text: '请先填写服务器地址', action: null });
      return;
    }
    await runTest(targetUrl, token.trim());
  }

  async function save(): Promise<void> {
    const modeChangedNow = snapshot !== null && mode !== snapshot.mode;
    const enteredToken = token.trim();
    setSaving(true);
    setActionError(null);
    try {
      const next = await client.update({
        // Omit `mode` unless it actually changes: a saved URL/token is the
        // pre-configuration a later migration needs and must not flip the
        // authority (or be rejected by the Host's mode-switch guard).
        ...(modeChangedNow ? { mode } : {}),
        ...(needsDiscard ? { discard: true } : {}),
        ...(urlChanged ? { serverUrl: urlValue } : {}),
        ...(enteredToken === '' ? {} : { token: enteredToken }),
      });
      applySnapshot(next);
      setMode(next.mode);
      setServerUrl(next.serverUrl ?? '');
      setToken('');
      setConfirmDiscard(false);
      setDirtyState(false);
      setTestResult(null);
      void refreshQueue();
      const baseNotice = modeChangedNow
        ? next.mode === 'server'
          ? '已切换到服务端模式'
          : '已切回本地模式'
        : '服务器配置已保存';
      if (next.serverUrl === null) {
        setNotice(baseNotice);
      } else {
        // 保存即验证: probe the address the Host just persisted. The token is
        // omitted unless the user typed a new one, so the Host falls back to
        // the stored token instead of the browser ever holding it.
        const result = await runTest(next.serverUrl, enteredToken);
        setNotice(
          `${baseNotice}${
            result === null
              ? '；连接测试请求失败'
              : result.ok
                ? '，连接正常'
                : '；连接测试未通过，请按提示处理'
          }`,
        );
      }
    } catch (cause) {
      setActionError({
        text: `保存失败：${describeError(cause, '请重试')}`,
        action: errorActionOf(cause),
      });
    } finally {
      setSaving(false);
    }
  }

  async function clearToken(): Promise<void> {
    setClearingToken(true);
    setActionError(null);
    try {
      const next = await client.update({ token: null });
      applySnapshot(next);
      setTestResult(null);
      setNotice('已清除设备 token');
    } catch (cause) {
      setActionError({
        text: `清除 token 失败：${describeError(cause, '请重试')}`,
        action: errorActionOf(cause),
      });
    } finally {
      setClearingToken(false);
    }
  }

  function focusTarget(target: HTMLElement | null): void {
    if (target === null) return;
    if (typeof target.scrollIntoView === 'function')
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
  }

  function goMigration(): void {
    if (onGoMigration !== undefined) onGoMigration();
    else if (typeof document !== 'undefined') {
      const element = document.querySelector<HTMLElement>(
        '[data-settings-target="migration"]',
      );
      if (element !== null) focusTarget(element);
    }
  }

  const status = snapshot?.connection ?? { state: 'local' as const };
  const pending = snapshot?.sync.pendingWrites ?? 0;
  const conflicts = snapshot?.sync.conflicts ?? 0;
  const failed = snapshot?.sync.failed ?? 0;
  const lastSynced = formatTimestamp(
    snapshot?.sync.lastSyncedAt ?? snapshot?.connection.lastSyncedAt,
  );
  const configuredUrl = snapshot?.serverUrl ?? null;
  const connectionIssue =
    status.state === 'error'
      ? status.message ?? '连接配置错误，请更新设备 token 或检查服务器地址'
      : status.state === 'offline'
        ? status.message ??
          '服务端离线，编辑会先保存在本机，恢复连接后自动提交待同步写入'
        : status.message ?? null;
  const serverMode = mode === 'server';
  const locked = saving || migrationRunning;
  // Only Host metadata proves a saved target works; the session probe result
  // is immediate feedback in the bar below, not a persistent verified state.
  const verificationLabel =
    snapshot !== null &&
    snapshot.lastVerifiedAt !== undefined &&
    snapshot.serverUrl !== null
      ? `最近验证 ${formatClock(snapshot.lastVerifiedAt) ?? ''}${
          snapshot.lastVerifiedVersion === undefined
            ? ''
            : ` · v${snapshot.lastVerifiedVersion}`
        }`
      : snapshot?.serverUrl !== null && snapshot?.serverUrl !== undefined
        ? '已保存，尚未验证'
        : null;
  const testAction =
    testResult !== null && !testResult.ok
      ? testFailureAction(testResult)
      : null;
  const discardable = queue.filter((entry) => entry.state !== 'pending').length;

  function focusToken(): void {
    focusTarget(tokenInput.current);
  }

  return (
    <SettingsSection id="settings-server" title="服务器">
      <div className={styles.rows}>
        <div className={`${styles.row} ${styles.rowSetting}`}>
          <span className={styles.rowLabel}>数据位置</span>
          <div className={styles.rowControl}>
            <span className={styles.modeSwitch} role="group" aria-label="空间模式">
              <button
                type="button"
                className={`${styles.modeButton} ${
                  !serverMode ? styles.modeButtonActive : ''
                }`}
                aria-pressed={!serverMode}
                disabled={locked}
                onClick={() => changeMode('local')}
              >
                本地
              </button>
              <button
                type="button"
                data-settings-target="mode-switch"
                className={`${styles.modeButton} ${
                  serverMode ? styles.modeButtonActive : ''
                }`}
                aria-pressed={serverMode}
                disabled={locked}
                onClick={() => changeMode('server')}
              >
                自部署服务器
              </button>
            </span>
          </div>
        </div>

        <div className={`${styles.row} ${styles.rowSetting} ${styles.textRow}`}>
          <label className={styles.rowLabel} htmlFor={urlId}>
            服务器地址
          </label>
          <div className={`${styles.rowControl} ${styles.textControl}`}>
            <input
              id={urlId}
              ref={urlInput}
              data-settings-target="server-url"
              className={styles.textInput}
              type="url"
              inputMode="url"
              placeholder="https://space.example.com"
              value={serverUrl}
              disabled={locked}
              onChange={(event) => changeUrl(event.target.value)}
            />
          </div>
        </div>
        <div className={`${styles.row} ${styles.rowSetting} ${styles.textRow}`}>
          <label className={styles.rowLabel} htmlFor={tokenId}>
            设备 token
          </label>
          <div className={`${styles.rowControl} ${styles.textControl}`}>
            <input
              id={tokenId}
              ref={tokenInput}
              data-settings-target="server-token"
              className={styles.textInput}
              type="password"
              autoComplete="off"
              placeholder={
                snapshot?.tokenConfigured
                  ? '已配置，留空保持不变'
                  : '粘贴服务端生成的 token'
              }
              value={token}
              disabled={locked}
              onChange={(event) => changeToken(event.target.value)}
            />
            {snapshot?.tokenConfigured === true && !serverMode ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || clearingToken}
                onClick={() => void clearToken()}
              >
                {clearingToken ? '清除中…' : '清除'}
              </Button>
            ) : null}
          </div>
        </div>
        {!serverMode ? (
          <p className={styles.rowHint} data-testid="server-target-hint">
            当前数据仍在本机。可先保存服务器地址与 token，供之后执行迁移或切换使用；保存它们不会切换模式。
          </p>
        ) : null}
        {serverMode && snapshot?.tokenConfigured === true ? (
          <p className={styles.rowHint} data-testid="server-token-locked">
            服务端模式下必须保留设备 token；更换 token 请直接输入新值并保存。
          </p>
        ) : null}
        {migrationRunning ? (
          <p className={styles.rowHint} data-testid="server-migration-lock">
            迁移进行中，服务器设置暂不可修改。
          </p>
        ) : null}
        {needsDiscard ? (
          <div
            className={`${styles.row} ${styles.rowSetting} ${styles.confirmRow}`}
            data-testid="mode-discard-confirm"
          >
            <label className={styles.confirmLabel}>
              <input
                type="checkbox"
                className={styles.confirmCheckbox}
                checked={confirmDiscard}
                disabled={locked}
                onChange={(event) => setConfirmDiscard(event.target.checked)}
              />
              <span>
                {modeChanged
                  ? mode === 'server'
                    ? '我确认切换到服务端：本地数据不会自动同步，未迁移的内容在服务端不可见。切换不会上传本地数据；要迁移请用下方「数据迁移」。'
                    : '我确认切回本地：本机尚未同步到服务端的内容会被丢弃，服务端之后的变化也不会同步回来。'
                  : '我确认更换服务器地址：旧服务器地址下尚未同步的本地写入会被丢弃。'}
              </span>
            </label>
            {modeChanged ? (
              <Button size="sm" variant="ghost" onClick={goMigration}>
                去迁移
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className={`${styles.row} ${styles.rowCompact}`}>
          <span className={styles.rowLabel}>连接状态</span>
          <div
            className={`${styles.rowControl} ${styles.wrapControl}`}
            data-testid="connection-status"
          >
            <span className={`${styles.statusLine} ${statusClass(status)}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              <span>{statusLabel(status)}</span>
            </span>
            {status.serverVersion ? (
              <span className={styles.rowMeta}>v{status.serverVersion}</span>
            ) : null}
            {snapshotMode === 'server' ? (
              <>
                <span className={styles.rowMeta}>
                  上次同步 {lastSynced ?? '—'}
                </span>
                <CountAction
                  value={pending}
                  label="待同步"
                  onActivate={() => focusTarget(queueRef.current)}
                />
                <CountAction
                  value={conflicts}
                  label="冲突"
                  onActivate={() => focusTarget(queueRef.current)}
                />
                <CountAction
                  value={failed}
                  label="未同步"
                  onActivate={() => focusTarget(queueRef.current)}
                />
              </>
            ) : null}
          </div>
        </div>

        <div className={`${styles.row} ${styles.rowCompact}`}>
          <span className={styles.rowLabel}>服务器验证</span>
          <span className={styles.rowValue} data-testid="last-verified">
            {verificationLabel ?? '未填写服务器地址'}
          </span>
        </div>

        {connectionIssue === null ? null : (
          <div className={styles.errorBar}>
            <span role="alert">{connectionIssue}</span>
            {status.state === 'offline' ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={testing || locked}
                onClick={() => void test()}
              >
                重试连接
              </Button>
            ) : status.state === 'error' ? (
              <Button size="sm" variant="ghost" onClick={focusToken}>
                更新 token
              </Button>
            ) : null}
          </div>
        )}

        {testResult ? (
          <div
            className={testResult.ok ? styles.noticeBar : styles.errorBar}
            role="status"
            data-testid="connection-test-result"
          >
            <span>
              {testResult.ok
                ? `连接成功${testResult.authenticated === true ? '，token 已通过校验' : '（未校验 token）'}${
                    testResult.serverVersion
                      ? ` · 服务端 v${testResult.serverVersion}`
                      : ''
                  }`
                : `连接失败：${testResult.message ?? '未知错误'}`}
            </span>
            {testAction === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  testAction === 'token'
                    ? focusToken()
                    : focusTarget(urlInput.current)
                }
              >
                {testAction === 'token' ? '更新 token' : '重试连接'}
              </Button>
            )}
          </div>
        ) : null}

        {actionError ? (
          <div className={styles.errorBar}>
            <span role="alert">{actionError.text}</span>
            {actionError.action === 'token' ? (
              <Button size="sm" variant="ghost" onClick={focusToken}>
                更新 token
              </Button>
            ) : actionError.action === 'retry' ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={testing || locked}
                onClick={() => void test()}
              >
                重试连接
              </Button>
            ) : null}
          </div>
        ) : null}

        {loadError ? (
          <div className={styles.errorBar}>
            <span role="alert">{loadError}</span>
          </div>
        ) : null}

        {snapshotMode === 'server' && queue.length > 0 ? (
          <div
            className={`${styles.queueList} ${styles.focusTarget}`}
            ref={queueRef}
            tabIndex={-1}
            data-settings-target="sync-queue"
            data-testid="sync-queue"
          >
            <div className={`${styles.row} ${styles.rowCompact}`}>
              <span className={styles.rowLabel}>待同步写入</span>
              <span className={styles.inlineActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    bulkAction !== null ||
                    resolving !== '' ||
                    migrationRunning ||
                    discardable === 0
                  }
                  onClick={() => void resolveMany('retry')}
                >
                  {bulkAction === 'retry' ? '重试中…' : '重试全部'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={bulkAction !== null || resolving !== '' || migrationRunning}
                  onClick={() => setConfirmDiscardAll(true)}
                >
                  丢弃全部
                </Button>
              </span>
            </div>
            {confirmDiscardAll ? (
              <div className={styles.confirmBar} data-testid="discard-all-confirm">
                <span>
                  丢弃全部 {queue.length}{' '}
                  篇文档的本地写入？内容将以服务端为准，无法恢复。
                </span>
                <span className={styles.inlineActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDiscardAll(false)}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={bulkAction !== null}
                    onClick={() => void resolveMany('discard')}
                  >
                    {bulkAction === 'discard' ? '丢弃中…' : '确认丢弃'}
                  </Button>
                </span>
              </div>
            ) : null}
            {queue.map((entry) => {
              const title = entry.title?.trim();
              const label = title === undefined || title === '' ? entry.docId : title;
              const updated = formatTimestamp(entry.updatedAt);
              const confirming = discardTarget === entry.docId;
              return (
                <div
                  className={styles.queueItem}
                  key={entry.docId}
                  data-testid={`queue-item-${entry.docId}`}
                >
                  <span className={styles.queueMeta}>
                    <span className={styles.rowValue}>{label}</span>
                    <span className={styles.rowMeta}>
                      {entry.entries} 条 · {queueStateLabel(entry.state)}
                      {updated === null ? '' : ` · 更新于 ${updated}`}
                      {entry.lastError === undefined
                        ? ''
                        : ` · ${entry.lastError}`}
                    </span>
                  </span>
                  <span className={styles.queueActions}>
                    {confirming ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDiscardTarget(null)}
                        >
                          取消
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={resolving !== ''}
                          onClick={() => void resolveEntry(entry.docId, 'discard')}
                        >
                          确认丢弃
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            resolving === entry.docId ||
                            entry.state === 'pending' ||
                            migrationRunning
                          }
                          onClick={() => void resolveEntry(entry.docId, 'retry')}
                        >
                          重试
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resolving === entry.docId || migrationRunning}
                          onClick={() => setDiscardTarget(entry.docId)}
                        >
                          丢弃本地写入
                        </Button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {notice ? (
          <div className={styles.noticeBar} role="status">
            <span>{notice}</span>
          </div>
        ) : null}

        <div className={`${styles.actions} ${styles.wrapActions}`}>
          {saveBlockedReason === null ? null : (
            <span className={styles.savedNote} data-testid="save-blocked-reason">
              {saveBlockedReason}
            </span>
          )}
          {effectiveUrl !== '' || configuredUrl !== null ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={testing || locked}
              onClick={() => void test()}
            >
              {testing ? '测试中…' : '测试连接'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => void copySetupPrompt()}
          >
            {copied ? '已复制' : '复制 AI 配置指令'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canSave || !dirty}
            onClick={() => void save()}
          >
            {saving
              ? modeChanged
                ? '切换中…'
                : '保存中…'
              : modeChanged
                ? '确认切换'
                : '保存并测试'}
          </Button>
        </div>

        <p className={styles.meta}>
          {snapshotMode === 'server'
            ? '服务端是唯一权威：多台设备连接同一服务端共享数据；本机不映射空间工作区，目录使用远端浏览或手工输入。'
            : '本地模式数据保存在本机 DSH 数据目录，可离线使用，并保留空间与 DSH 工作区的映射。'}
          {' '}
          两种模式不会自动同步；切换模式需要勾选确认，数据迁移入口在下方「数据迁移」。
        </p>
      </div>
    </SettingsSection>
  );
}