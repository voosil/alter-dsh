/**
 * "存储与备份" section of the Space settings page.
 *
 * The vendored upstream settings page is kept byte-identical, so this section
 * is composed by the DSH shell right below it. It edits the two bounded
 * storage policies (version history depth, daily snapshot ring), shows the
 * Host-computed footprint estimate for the current data, and updates the
 * estimate live while the inputs change.
 */
import { useEffect, useId, useState } from 'react';
import { Button, Field, Input } from '@alter/ui-system';
import {
  type SpaceStorageClient,
  type StorageEstimate,
  type StorageSettings,
} from './storage-client.js';

/** Must mirror `host/settings.ts`; the Host still clamps malformed input. */
const LIMITS = {
  historyLimit: { min: 1, max: 100 },
  snapshotKeep: { min: 1, max: 30 },
} as const;

const DEFAULT_SETTINGS: StorageSettings = { historyLimit: 10, snapshotKeep: 3 };

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

function formatSigned(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) return '不变';
  return `${bytes > 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`;
}

function clampDraft(draft: StorageSettings): StorageSettings | undefined {
  for (const key of ['historyLimit', 'snapshotKeep'] as const) {
    const value = draft[key];
    if (!Number.isInteger(value)) return undefined;
    const limits = LIMITS[key];
    if (value < limits.min || value > limits.max) return undefined;
  }
  return draft;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败，请重试';
}

export interface StorageSettingsSectionProps {
  storage: SpaceStorageClient;
}

export function StorageSettingsSection({ storage }: StorageSettingsSectionProps) {
  const historyId = useId();
  const snapshotsId = useId();
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<StorageSettings | null>(null);
  /** Estimate for the saved policy (the baseline of the delta). */
  const [baseline, setBaseline] = useState<StorageEstimate | null>(null);
  /** Estimate for the draft policy shown in the inputs. */
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [draft, setDraft] = useState<StorageSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void storage
      .get()
      .then((state) => {
        if (!active) return;
        setSaved(state.settings);
        setDraft(state.settings);
        setBaseline(state.estimate);
        setEstimate(state.estimate);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(describeError(cause));
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [storage]);

  const candidate = clampDraft(draft);

  // Live estimate while the draft changes (250 ms debounce, latest wins).
  useEffect(() => {
    if (!loaded || saving || !candidate) return;
    let active = true;
    const timer = setTimeout(() => {
      void storage
        .estimate(candidate)
        .then((next) => {
          if (active) setEstimate(next);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [candidate, loaded, saving, storage]);

  const dirty =
    saved !== null &&
    (saved.historyLimit !== draft.historyLimit ||
      saved.snapshotKeep !== draft.snapshotKeep);
  const deltaBytes =
    estimate !== null && baseline !== null
      ? estimate.projectedBytes - baseline.projectedBytes
      : null;
  const current = estimate ?? baseline;

  function change(key: keyof StorageSettings, raw: string) {
    const value = Number.parseInt(raw, 10);
    setDraft((previous) => ({
      ...previous,
      [key]: Number.isNaN(value) ? previous[key] : value,
    }));
    setNotice('');
    setError('');
  }

  async function save() {
    if (!candidate) {
      setError('请输入有效范围内的数值');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const state = await storage.set(candidate);
      setSaved(state.settings);
      setDraft(state.settings);
      setBaseline(state.estimate);
      setEstimate(state.estimate);
      setNotice('已保存，历史裁剪与备份保留已按新设置生效');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="alter-space-storage"
      id="settings-storage"
      aria-labelledby="storage-title"
    >
      <div className="alter-space-storage-label" aria-hidden="true">
        存储
      </div>
      <div className="alter-space-storage-body">
        <div className="alter-space-storage-head">
          <h2 className="alter-space-storage-title" id="storage-title">
            存储与备份
          </h2>
          <p className="alter-space-storage-note">
            每天自动生成一份整库快照；文档版本按篇裁剪。修改后立即按当前文档数量估算占用。
          </p>
        </div>

        <div className="alter-space-storage-fields">
          <Field
            label="版本历史上限（每篇文档）"
            htmlFor={historyId}
            hint={`${LIMITS.historyLimit.min}–${LIMITS.historyLimit.max} 版；单篇另有 64 KiB 字节上限`}
          >
            <Input
              id={historyId}
              type="number"
              inputMode="numeric"
              min={LIMITS.historyLimit.min}
              max={LIMITS.historyLimit.max}
              step={1}
              value={draft.historyLimit}
              disabled={saving}
              onChange={(event) => change('historyLimit', event.target.value)}
            />
          </Field>
          <Field
            label="每日快照保留"
            htmlFor={snapshotsId}
            hint={`${LIMITS.snapshotKeep.min}–${LIMITS.snapshotKeep.max} 份；每天最多一份`}
          >
            <Input
              id={snapshotsId}
              type="number"
              inputMode="numeric"
              min={LIMITS.snapshotKeep.min}
              max={LIMITS.snapshotKeep.max}
              step={1}
              value={draft.snapshotKeep}
              disabled={saving}
              onChange={(event) => change('snapshotKeep', event.target.value)}
            />
          </Field>
        </div>

        <dl className="alter-space-storage-estimate" aria-label="存储占用估算">
          <div className="alter-space-storage-row">
            <dt>当前数据</dt>
            <dd>
              {current
                ? `${current.documentCount} 篇文档，平均 ${formatBytes(current.averageDocumentBytes)}`
                : '正在读取…'}
            </dd>
          </div>
          <div className="alter-space-storage-row">
            <dt>当前实际占用</dt>
            <dd>
              {current
                ? `${formatBytes(current.currentBytes)}（主库 ${formatBytes(current.currentMainBytes)} + 快照 ${formatBytes(current.currentSnapshotBytes)}）`
                : '—'}
            </dd>
          </div>
          <div className="alter-space-storage-row">
            <dt>当前设置预计上限</dt>
            <dd>{baseline ? formatBytes(baseline.projectedBytes) : '—'}</dd>
          </div>
          <div className="alter-space-storage-row alter-space-storage-row-strong">
            <dt>修改后预计上限</dt>
            <dd>
              {estimate ? formatBytes(estimate.projectedBytes) : '—'}
              {deltaBytes !== null ? (
                <span
                  className={
                    deltaBytes > 0
                      ? 'alter-space-storage-delta-up'
                      : 'alter-space-storage-delta'
                  }
                >
                  （较当前设置 {formatSigned(deltaBytes)}）
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        <p className="alter-space-storage-hint">
          上限按每篇版本历史填满、快照按保守压缩比估算；不含 WAL（≤16
          MiB）与损坏兜底副本（≤256 MiB）。
        </p>

        {notice ? (
          <p className="alter-space-storage-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="alter-space-storage-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="alter-space-storage-foot">
          <span className="alter-space-storage-hint">
            {saved
              ? `当前设置：每篇 ${saved.historyLimit} 版历史，保留 ${saved.snapshotKeep} 份每日快照`
              : '正在读取存储设置…'}
          </span>
          <Button
            type="button"
            variant="primary"
            disabled={!loaded || !dirty || saving || !candidate}
            onClick={() => void save()}
          >
            {saving ? '正在保存…' : '保存设置'}
          </Button>
        </div>
      </div>
    </section>
  );
}
