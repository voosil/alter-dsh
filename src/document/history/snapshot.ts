/**
 * Defensive readers for version-history data.
 *
 * `doc.get` and `doc.restoreVersion` return RPC values typed as `unknown`;
 * version rows store serialized ASTs that may be corrupt or from an old format.
 * These helpers validate just enough to render the history panel without
 * crashing and turn RPC errors into readable Chinese messages.
 *
 * @module @alter-dsh/space/document/history/snapshot
 */
import type { AlterDoc } from '../types';
import { SpaceRemoteError } from '../../space-client';
import { formatDateTime } from '../../../vendor/ui-space/src/utils/date';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A parsed, validated document snapshot. */
export interface HistorySnapshot {
  doc: AlterDoc;
  revision: number;
  title: string;
}

function readAlterDoc(value: unknown): AlterDoc | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (record['format'] !== 'alter-doc/1') return undefined;
  if (!Array.isArray(record['blocks'])) return undefined;
  return record as unknown as AlterDoc;
}

/**
 * Read a `doc.get` result into a snapshot, or `undefined` when the shape is not
 * an AST document (the panel then shows a readable hint instead of crashing).
 */
export function readHistorySnapshot(value: unknown): HistorySnapshot | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const doc = readAlterDoc(record['doc']);
  if (doc === undefined) return undefined;
  const revision = record['revision'];
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    return undefined;
  }
  const title = record['title'];
  return {
    doc,
    revision,
    title: typeof title === 'string' ? title : '',
  };
}

/** Read the new revision from a `doc.restoreVersion` result. */
export function readRestoredRevision(value: unknown): number | undefined {
  const record = asRecord(value);
  const revision = record?.['revision'];
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

/** Readable restore error: known RPC codes get a concrete next step. */
export function describeRestoreError(error: unknown): string {
  if (error instanceof SpaceRemoteError) {
    switch (error.code) {
      case 'doc/conflict':
        return '文档已被修改（revision 冲突），请刷新后再恢复。';
      case 'doc/not-found':
        return '文档不存在或已被删除，无法恢复。';
      case 'op/invalid':
        return `版本无法恢复：${error.message}`;
      default:
        return error.message;
    }
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return '恢复失败，请重试。';
}

/** Format one version timestamp for the narrow panel. */
export function formatVersionTime(value: string): string {
  if (Number.isNaN(Date.parse(value))) return value;
  return formatDateTime(value);
}

/** Display title of a version row (empty title keeps the placeholder). */
export function versionTitle(title: string): string {
  return title.trim() === '' ? '无标题' : title;
}

