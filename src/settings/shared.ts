/**
 * Small helpers shared by the settings page and its sections.
 *
 * The settings surface only talks to the Host over the settings/migration RPC
 * clients; everything here is presentation-level: error text, clock labels,
 * the Chinese migration phase vocabulary and the DOM anchors the overview uses
 * to move focus to the control that fixes a problem.
 *
 * @module @alter-dsh/space/settings/shared
 */
import type { SpaceMigrationState } from '../client/rpc.js';

/** One successful connection probe kept for this page session. */
export interface SettingsVerification {
  /** ISO instant of the successful probe. */
  at: string;
  /** Server version reported by that probe, when known. */
  serverVersion?: string;
  /** Normalized server URL the probe targeted. */
  serverUrl: string;
}

/** Settings controls the access overview and fix entries can move focus to. */
export type SettingsFocusTarget =
  | 'server-url'
  | 'server-token'
  | 'mode-switch'
  | 'sync-queue'
  | 'migration';

/** Human-readable error text with a fallback for non-Error causes. */
export function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** `HH:mm` for a timestamp, or `null` when absent/unparseable. */
export function formatClock(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** `HH:mm` for today, otherwise `M月D日 HH:mm`; `null` when absent. */
export function formatTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const clock = formatClock(value);
  if (clock === null) return null;
  const today = new Date();
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
    return clock;
  const day = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date);
  return `${day} ${clock}`;
}

/** Host part of a server URL for status lines; the raw value when unparseable. */
export function hostOf(serverUrl: string | null | undefined): string | null {
  if (serverUrl === null || serverUrl === undefined || serverUrl === '')
    return null;
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/** Byte size with a binary unit, as the migration preflight reports it. */
export function formatBytes(bytes: number): string {
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

/** Chinese names for the transfer phases the Host reports. */
const MIGRATION_PHASE_LABELS: Record<string, string> = {
  preflight: '预检',
  'pack-assets': '打包资产',
  'upload-assets': '传输资产',
  freeze: '暂停写入',
  snapshot: '导出快照',
  'upload-database': '上传数据库',
  commit: '提交并校验',
  download: '下载快照',
  unpack: '解包',
  verify: '校验数据',
  switch: '切换数据位置',
  done: '完成',
  cancelled: '已取消',
  failed: '失败',
};

/** Chinese label for one migration phase; unknown phases pass through. */
export function migrationPhaseLabel(phase: string | undefined): string | null {
  if (phase === undefined || phase === '') return null;
  return MIGRATION_PHASE_LABELS[phase] ?? phase;
}

/** Whole-percent progress for a running job, or `null` when unknown. */
export function migrationPercent(
  state: SpaceMigrationState | null,
): number | null {
  if (
    state === null ||
    state.status !== 'running' ||
    state.totalBytes === null ||
    state.totalBytes <= 0
  )
    return null;
  return Math.min(
    100,
    Math.round((state.transferredBytes / state.totalBytes) * 100),
  );
}

/**
 * Scroll a control into view and focus it. Tolerates a missing target (the
 * control may not be rendered yet) and jsdom, which does not implement
 * `scrollIntoView`.
 */
export function focusSettingsTarget(target: SettingsFocusTarget): void {
  if (typeof document === 'undefined') return;
  const element = document.querySelector<HTMLElement>(
    `[data-settings-target="${target}"]`,
  );
  if (element === null) return;
  if (typeof element.scrollIntoView === 'function')
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  element.focus({ preventScroll: true });
}