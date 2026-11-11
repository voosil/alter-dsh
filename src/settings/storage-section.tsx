/**
 * "存储与备份" section of the Space settings page.
 *
 * The Host owns the SQLite database, so retention depth and the daily snapshot
 * ring are the two bounded policies a user can tune here. The form edits a
 * draft, asks the Host to re-estimate the footprint while the draft changes,
 * and commits both policies in one call.
 */
import { useEffect, useId, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@alter/ui-system';
import { SettingsSection } from './section';
import {
  type SpaceStorageClient,
  type StorageEstimate,
  type StorageSettings,
  type StorageState,
} from '../client/storage.js';
import styles from './settings.module.css';

/** Must mirror `host/settings.ts`; the Host still clamps malformed input. */
const LIMITS = {
  historyLimit: { min: 1, max: 100 },
  snapshotKeep: { min: 1, max: 30 },
} as const;

const DEFAULTS: StorageSettings = { historyLimit: 10, snapshotKeep: 3 };
const SAVED_NOTICE_MS = 2400;

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

function clamp(value: number, key: keyof StorageSettings): number {
  const { min, max } = LIMITS[key];
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export interface StorageSettingsSectionProps {
  storage: SpaceStorageClient;
}

export function StorageSettingsSection({ storage }: StorageSettingsSectionProps) {
  const historyId = useId();
  const snapshotId = useId();
  const [stored, setStored] = useState<StorageState | null>(null);
  const [draft, setDraft] = useState<StorageSettings>(DEFAULTS);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  /** Bumped by the retry control after a failed initial read. */
  const [attempt, setAttempt] = useState(0);

  const loaded = stored !== null;
  const valid =
    Number.isInteger(draft.historyLimit) &&
    Number.isInteger(draft.snapshotKeep) &&
    draft.historyLimit >= LIMITS.historyLimit.min &&
    draft.historyLimit <= LIMITS.historyLimit.max &&
    draft.snapshotKeep >= LIMITS.snapshotKeep.min &&
    draft.snapshotKeep <= LIMITS.snapshotKeep.max;
  const dirty =
    loaded &&
    (stored.settings.historyLimit !== draft.historyLimit ||
      stored.settings.snapshotKeep !== draft.snapshotKeep);

  useEffect(() => {
    let active = true;
    void storage
      .get()
      .then((state) => {
        if (!active) return;
        setStored(state);
        setDraft(state.settings);
        setEstimate(state.estimate);
      })
      .catch((cause: unknown) => {
        if (active) setError(`读取失败：${describeError(cause, '请重试')}`);
      });
    return () => {
      active = false;
    };
  }, [storage, attempt]);

  // Live footprint while the draft changes: the saved policy keeps the last
  // Host estimate, a valid draft asks again (250 ms debounce, latest wins).
  useEffect(() => {
    if (!stored) return;
    if (!dirty) {
      setEstimate(stored.estimate);
      return;
    }
    if (!valid) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void storage
        .estimate(draft)
        .then((next) => {
          if (active) setEstimate(next);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft, dirty, stored, valid, storage]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  function change(key: keyof StorageSettings, value: number) {
    if (!Number.isInteger(value)) return;
    setDraft((current) => ({ ...current, [key]: value }));
    setError('');
    setSaved(false);
  }

  function nudge(key: keyof StorageSettings, step: number) {
    change(key, clamp(draft[key] + step, key));
  }

  function normalize(key: keyof StorageSettings) {
    setDraft((current) => ({ ...current, [key]: clamp(current[key], key) }));
  }

  function reset() {
    if (!stored) return;
    setDraft(stored.settings);
    setEstimate(stored.estimate);
    setError('');
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const state = await storage.set(draft);
      setStored(state);
      setDraft(state.settings);
      setEstimate(state.estimate);
      setSaved(true);
    } catch (cause) {
      setError(`保存失败：${describeError(cause, '请重试')}`);
    } finally {
      setSaving(false);
    }
  }

  const shown = estimate ?? stored?.estimate ?? null;
  const delta =
    shown && stored && dirty
      ? shown.projectedBytes - stored.estimate.projectedBytes
      : 0;
  const invalidHint = `版本历史 ${LIMITS.historyLimit.min}–${LIMITS.historyLimit.max}，每日快照 ${LIMITS.snapshotKeep.min}–${LIMITS.snapshotKeep.max}`;
  const savedNote = saved && !dirty ? '已保存' : '';

  return (
    <SettingsSection id="settings-storage" title="存储与备份">
      <div className={styles.rows}>
        <div className={`${styles.row} ${styles.rowSetting}`}>
          <label className={styles.rowLabel} htmlFor={historyId}>
            版本历史
          </label>
          <div className={styles.rowControl}>
            <span className={styles.stepper}>
              <button
                type="button"
                className={styles.stepButton}
                aria-label="减少版本历史"
                disabled={
                  !loaded ||
                  saving ||
                  draft.historyLimit <= LIMITS.historyLimit.min
                }
                onClick={() => nudge('historyLimit', -1)}
              >
                <Minus size={12} strokeWidth={2} aria-hidden="true" />
              </button>
              <input
                id={historyId}
                className={styles.stepInput}
                type="number"
                inputMode="numeric"
                min={LIMITS.historyLimit.min}
                max={LIMITS.historyLimit.max}
                step={1}
                value={draft.historyLimit}
                disabled={!loaded || saving}
                onChange={(event) =>
                  change('historyLimit', Number.parseInt(event.target.value, 10))
                }
                onBlur={() => normalize('historyLimit')}
              />
              <button
                type="button"
                className={styles.stepButton}
                aria-label="增加版本历史"
                disabled={
                  !loaded ||
                  saving ||
                  draft.historyLimit >= LIMITS.historyLimit.max
                }
                onClick={() => nudge('historyLimit', 1)}
              >
                <Plus size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
            <span className={styles.unit}>版/篇</span>
          </div>
        </div>

        <div className={`${styles.row} ${styles.rowSetting}`}>
          <label className={styles.rowLabel} htmlFor={snapshotId}>
            每日快照
          </label>
          <div className={styles.rowControl}>
            <span className={styles.stepper}>
              <button
                type="button"
                className={styles.stepButton}
                aria-label="减少每日快照"
                disabled={
                  !loaded ||
                  saving ||
                  draft.snapshotKeep <= LIMITS.snapshotKeep.min
                }
                onClick={() => nudge('snapshotKeep', -1)}
              >
                <Minus size={12} strokeWidth={2} aria-hidden="true" />
              </button>
              <input
                id={snapshotId}
                className={styles.stepInput}
                type="number"
                inputMode="numeric"
                min={LIMITS.snapshotKeep.min}
                max={LIMITS.snapshotKeep.max}
                step={1}
                value={draft.snapshotKeep}
                disabled={!loaded || saving}
                onChange={(event) =>
                  change('snapshotKeep', Number.parseInt(event.target.value, 10))
                }
                onBlur={() => normalize('snapshotKeep')}
              />
              <button
                type="button"
                className={styles.stepButton}
                aria-label="增加每日快照"
                disabled={
                  !loaded ||
                  saving ||
                  draft.snapshotKeep >= LIMITS.snapshotKeep.max
                }
                onClick={() => nudge('snapshotKeep', 1)}
              >
                <Plus size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
            <span className={styles.unit}>份</span>
          </div>
        </div>
      </div>

      {error ? (
        <div className={styles.errorBar}>
          <span role="alert">{error}</span>
          {loaded ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setError('');
                setAttempt((current) => current + 1);
              }}
            >
              重试
            </Button>
          )}
        </div>
      ) : null}

      {loaded ? (
        <div className={styles.footer}>
          {!valid ? (
            <p className={styles.meta}>{invalidHint}</p>
          ) : shown ? (
            <p className={styles.meta}>
              <span>{shown.documentCount} 篇文档</span>
              <span className={styles.metaDot} aria-hidden="true" />
              <span>当前 {formatBytes(shown.currentBytes)}</span>
              <span className={styles.metaDot} aria-hidden="true" />
              <span>
                预计上限 {formatBytes(shown.projectedBytes)}
                {delta !== 0 ? (
                  <span className={styles.metaDelta}>
                    （{delta > 0 ? '+' : '−'}
                    {formatBytes(Math.abs(delta))}）
                  </span>
                ) : null}
              </span>
            </p>
          ) : (
            <span />
          )}
          <div className={styles.actions}>
            <span className={styles.savedNote} role="status" aria-live="polite">
              {savedNote}
            </span>
            {dirty && !saving ? (
              <Button size="sm" variant="ghost" onClick={reset}>
                取消
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={dirty ? 'primary' : 'secondary'}
              className={dirty ? undefined : styles.quietAction}
              disabled={!dirty || !valid || saving}
              onClick={() => void save()}
            >
              {saving ? '正在保存…' : '保存'}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
