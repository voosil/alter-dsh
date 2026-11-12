/**
 * "服务器" section of the Space settings page.
 *
 * Selects the authority mode, edits the self-hosted server URL/token, probes
 * the link and shows queue/conflict state. Tokens are write-only from the
 * browser: the section only learns whether one is configured.
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
import styles from './settings.module.css';

const STATUS_POLL_MS = 5_000;
const NOTICE_MS = 2_400;

/** Prompt copied by the "让 AI 配置" entry; matches the shipped deploy skill. */
const AI_SETUP_PROMPT =
  '请帮我部署并接通 Space 自部署服务端：使用本仓库的 Dockerfile/docker-compose 在服务器上启动 Space 服务（生成命名 token、挂载数据卷、跑健康检查），然后通过 space_settings 工具把当前插件切换到服务端模式并验证连接；需要我提供的信息一次问清，token 不要回显。如果要把现有本地空间迁过去，先备份再按迁移流程执行。';

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
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

export interface ServerSettingsSectionProps {
  client: SpaceSettingsClient;
}

export function ServerSettingsSection({ client }: ServerSettingsSectionProps) {
  const urlId = useId();
  const tokenId = useId();
  const [snapshot, setSnapshot] = useState<SpaceSettingsSnapshot | null>(null);
  const [mode, setMode] = useState<'local' | 'server'>('local');
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SpaceRemoteTestResult | null>(null);
  const [queue, setQueue] = useState<SpaceSyncQueueEntry[]>([]);
  const [resolving, setResolving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  // The poll timer is created once per client; a ref keeps it from writing a
  // stale `dirty=false` over fields the user is editing.
  const dirtyRef = useRef(false);
  const setDirtyState = (next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  };

  function applySnapshot(next: SpaceSettingsSnapshot) {
    if (!mounted.current) return;
    setSnapshot(next);
    if (!dirtyRef.current) {
      setMode(next.mode);
      setServerUrl(next.serverUrl ?? '');
    }
  }

  async function refresh(): Promise<void> {
    try {
      const next = await client.get();
      applySnapshot(next);
      if (mounted.current && !dirtyRef.current) setError('');
    } catch (cause) {
      if (mounted.current)
        setError(`读取设置失败：${describeError(cause, '请重试')}`);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, STATUS_POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The queue is only meaningful while the server owns the data; a failed
  // poll keeps the last rows so the user can still act on them.
  async function refreshQueue(): Promise<void> {
    try {
      const entries = await client.syncQueue();
      if (mounted.current) setQueue(entries);
    } catch {
      // The status poll already surfaces link failures.
    }
  }

  useEffect(() => {
    if (snapshot?.mode !== 'server') {
      setQueue([]);
      return;
    }
    void refreshQueue();
    const timer = window.setInterval(() => {
      void refreshQueue();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, snapshot?.mode]);

  async function resolveEntry(
    docId: string,
    action: 'retry' | 'discard',
  ): Promise<void> {
    setResolving(docId);
    setError('');
    try {
      const result = await client.resolveSync(docId, action);
      applySnapshot(result.state);
      setNotice(
        action === 'retry'
          ? `已重新提交 ${result.resolved} 条写入`
          : `已丢弃 ${result.resolved} 条本地写入，内容以服务端为准`,
      );
      await refreshQueue();
    } catch (cause) {
      setError(
        `${
          action === 'retry' ? '重试' : '丢弃'
        }失败：${describeError(cause, '请重试')}`,
      );
    } finally {
      setResolving('');
    }
  }

  async function copySetupPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(AI_SETUP_PROMPT);
      setCopied(true);
      setNotice('配置指令已复制，粘贴到对话里即可让 AI 接管部署与配置');
      window.setTimeout(() => setCopied(false), NOTICE_MS);
    } catch {
      setError('浏览器不允许写剪贴板，请手动复制部署说明');
    }
  }

  function changeMode(next: 'local' | 'server') {
    setMode(next);
    setDirtyState(true);
    setError('');
    setTestResult(null);
  }

  function changeUrl(value: string) {
    setServerUrl(value);
    setDirtyState(true);
    setError('');
    setTestResult(null);
  }

  function changeToken(value: string) {
    setToken(value);
    setDirtyState(true);
    setError('');
    setTestResult(null);
  }

  const effectiveUrl = serverUrl.trim();
  const canSave =
    !saving &&
    (mode === 'local' ||
      (effectiveUrl !== '' &&
        (snapshot?.tokenConfigured === true || token.trim() !== '')));

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const next = await client.update({
        mode,
        ...(mode === 'server' ? { serverUrl: effectiveUrl } : {}),
        ...(token.trim() === '' ? {} : { token: token.trim() }),
      });
      setSnapshot(next);
      setMode(next.mode);
      setServerUrl(next.serverUrl ?? '');
      setToken('');
      setDirtyState(false);
      setNotice(mode === 'server' ? '已切换到服务端模式' : '已切换到本地模式');
    } catch (cause) {
      setError(`保存失败：${describeError(cause, '请重试')}`);
    } finally {
      setSaving(false);
    }
  }

  async function test(): Promise<void> {
    if (effectiveUrl === '') {
      setError('请先填写服务器地址');
      return;
    }
    setTesting(true);
    setError('');
    setTestResult(null);
    try {
      const result = await client.test({
        serverUrl: effectiveUrl,
        ...(token.trim() === '' ? {} : { token: token.trim() }),
      });
      setTestResult(result);
    } catch (cause) {
      setError(`测试失败：${describeError(cause, '请重试')}`);
    } finally {
      setTesting(false);
    }
  }

  const status = snapshot?.connection ?? { state: 'local' as const };
  const pending = snapshot?.sync.pendingWrites ?? 0;
  const conflicts = snapshot?.sync.conflicts ?? 0;
  const failed = snapshot?.sync.failed ?? 0;
  const serverMode = mode === 'server';

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
                disabled={saving}
                onClick={() => changeMode('local')}
              >
                本地
              </button>
              <button
                type="button"
                className={`${styles.modeButton} ${
                  serverMode ? styles.modeButtonActive : ''
                }`}
                aria-pressed={serverMode}
                disabled={saving}
                onClick={() => changeMode('server')}
              >
                自部署服务器
              </button>
            </span>
          </div>
        </div>

        {serverMode ? (
          <>
            <div className={`${styles.row} ${styles.rowSetting} ${styles.textRow}`}>
              <label className={styles.rowLabel} htmlFor={urlId}>
                服务器地址
              </label>
              <div className={`${styles.rowControl} ${styles.textControl}`}>
                <input
                  id={urlId}
                  className={styles.textInput}
                  type="url"
                  inputMode="url"
                  placeholder="https://space.example.com"
                  value={serverUrl}
                  disabled={saving}
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
                  className={styles.textInput}
                  type="password"
                  autoComplete="off"
                  placeholder={
                    snapshot?.tokenConfigured
                      ? '已配置，留空保持不变'
                      : '粘贴服务端生成的 token'
                  }
                  value={token}
                  disabled={saving}
                  onChange={(event) => changeToken(event.target.value)}
                />
              </div>
            </div>
          </>
        ) : null}

        <div className={`${styles.row} ${styles.rowCompact}`}>
          <span className={styles.rowLabel}>连接状态</span>
          <div className={styles.rowControl}>
            <span className={`${styles.statusLine} ${statusClass(status)}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              <span>{statusLabel(status)}</span>
            </span>
            {status.serverVersion ? (
              <span className={styles.rowMeta}>v{status.serverVersion}</span>
            ) : null}
            {pending > 0 ? (
              <span className={styles.rowMeta}>{pending} 条待同步</span>
            ) : null}
            {conflicts > 0 ? (
              <span className={styles.rowMeta}>{conflicts} 条冲突</span>
            ) : null}
            {failed > 0 ? (
              <span className={styles.rowMeta}>{failed} 条未能同步</span>
            ) : null}
          </div>
        </div>

        {status.message ? (
          <div className={styles.errorBar}>
            <span role="alert">{status.message}</span>
          </div>
        ) : null}

        {testResult ? (
          <div
            className={testResult.ok ? styles.noticeBar : styles.errorBar}
            role="status"
          >
            <span>
              {testResult.ok
                ? `连接成功${testResult.authenticated ? '，token 已通过校验' : '（未校验 token）'}${
                    testResult.serverVersion
                      ? ` · 服务端 v${testResult.serverVersion}`
                      : ''
                  }`
                : `连接失败：${testResult.message ?? '未知错误'}`}
            </span>
          </div>
        ) : null}

        {error ? (
          <div className={styles.errorBar}>
            <span role="alert">{error}</span>
          </div>
        ) : null}

        {serverMode && queue.length > 0 ? (
          <div className={`${styles.row} ${styles.rowSetting}`}>
            <span className={styles.rowLabel}>待同步写入</span>
            <div className={`${styles.rowControl} ${styles.queueList}`}>
              {queue.map((entry) => (
                <div className={styles.queueItem} key={entry.docId}>
                  <span className={styles.queueMeta}>
                    <span className={styles.rowValue}>{entry.docId}</span>
                    <span className={styles.rowMeta}>
                      {entry.entries} 条 ·{' '}
                      {entry.state === 'pending'
                        ? '等待连接'
                        : entry.state === 'conflict'
                          ? '与服务端冲突'
                          : '提交失败'}
                      {entry.lastError ? ` · ${entry.lastError}` : ''}
                    </span>
                  </span>
                  <span className={styles.queueActions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolving === entry.docId || entry.state === 'pending'}
                      onClick={() => void resolveEntry(entry.docId, 'retry')}
                    >
                      重试
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolving === entry.docId}
                      onClick={() => void resolveEntry(entry.docId, 'discard')}
                    >
                      丢弃本地写入
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className={styles.noticeBar} role="status">
            <span>{notice}</span>
          </div>
        ) : null}

        <div className={styles.actions}>
          {serverMode ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={testing || saving || effectiveUrl === ''}
              onClick={() => void test()}
            >
              {testing ? '测试中…' : '测试连接'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
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
            {saving ? '保存中…' : serverMode ? '保存并切换' : '切换回本地'}
          </Button>
        </div>

        <p className={styles.meta}>
          {serverMode
            ? '服务端是唯一权威：多台设备连接同一服务端共享数据；本机不映射空间工作区，目录使用远端浏览或手工输入。'
            : '本地模式数据保存在本机 DSH 数据目录，可离线使用，并保留空间与 DSH 工作区的映射。'}
          {' '}
          两种模式不会自动同步，切换前请先迁移数据。
        </p>
      </div>
    </SettingsSection>
  );
}
