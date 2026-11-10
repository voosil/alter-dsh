/**
 * Save scheduling and the document save pipeline for the Tiptap surface.
 *
 * Two collaborating pieces live here so both can be unit tested without React:
 *
 * 1. {@link createAutosaveController} — debounce, single-flight serialization,
 *    draft throttling, retry and conflict blocking. It knows nothing about
 *    documents; the component supplies capture/save/draft callbacks.
 * 2. {@link createDocumentSaver} — one save cycle: title metadata write, body
 *    diff → Document Operations, idempotency-key reuse, and `doc/conflict`
 *    reconciliation against the current Host snapshot.
 *
 * Behaviour contract (P0 save lifecycle):
 * - edits are saved ~700ms after they stop; success is silent;
 * - at most one save request is in flight; edits made meanwhile queue another
 *   cycle after the receipt and are never overwritten by it;
 * - a save failure keeps the local content, persists a draft and exposes a
 *   retry action;
 * - a `doc/conflict` is first reconciled: when the Host content already equals
 *   what this client tried to write the save is considered successful;
 *   otherwise the local content is kept as a draft and surfaced as a conflict.
 *
 * @module @alter-dsh/space/document/editor/autosave
 */
import type { JSONContent } from '@tiptap/core';
import type { SpaceDocumentClient } from '../../space-client';
import { SpaceRemoteError } from '../../space-client';
import type { AlterDoc, Operation } from '../types';
import {
  blocksContentEquivalent,
  normalizeTitle,
  type DocumentDraft,
  type DocumentDraftPayload,
} from './draft';
import { tiptapToBlocks } from './mapping';
import {
  DocumentDiffError,
  computeOperations,
} from './operations';

/** Idle delay after the last edit before a save is attempted. */
export const AUTOSAVE_DEBOUNCE_MS = 700;

/** Minimum interval between localStorage draft writes while typing. */
export const DRAFT_WRITE_INTERVAL_MS = 1000;

/** Result of one save cycle. */
export type SaveOutcome =
  | { kind: 'saved'; revision: number }
  | { kind: 'skipped' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; message: string; serverRevision?: number };

/** Visible save status of the editor surface. */
export type AutosaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; message: string };

type TimerHandle = ReturnType<typeof setTimeout>;

/** Collaborators of the autosave controller. */
export interface AutosaveControllerOptions {
  /** Capture the current draft payload, or undefined when no editor exists. */
  captureDraft: () => DocumentDraftPayload | undefined;
  /** Persist one draft (throttled by the controller). */
  writeDraft: (draft: DocumentDraft) => void;
  /** Remove the persisted draft after a confirmed save. */
  clearDraft: () => void;
  /** Run one save cycle; must resolve (never reject) with the outcome. */
  save: () => Promise<SaveOutcome>;
  /** Receives every status transition (except after dispose). */
  onStatus: (status: AutosaveStatus) => void;
  debounceMs?: number;
  draftIntervalMs?: number;
  now?: () => number;
}

/** Handle returned by {@link createAutosaveController}. */
export interface AutosaveController {
  /** Mark the editor dirty and schedule the debounced save + draft write. */
  notifyChange(): void;
  /** Save immediately (Cmd/Ctrl+S, visibility/pagehide, unmount). */
  flush(): Promise<void>;
  /** Leave a failed/conflict state and retry the pending content. */
  retry(): Promise<void>;
  /** Forget pending work and reset the status (external snapshot adoption). */
  reset(): void;
  /** Persist the current draft synchronously (beforeunload). */
  persistDraftNow(): void;
  /** Report a failure discovered outside the save cycle (reload actions). */
  fail(message: string): void;
  /** Whether edits are waiting to be saved. */
  hasPending(): boolean;
  getStatus(): AutosaveStatus;
  /** Write a final draft and fire one last save attempt (unmount). */
  dispose(): void;
}

function sameStatus(left: AutosaveStatus, right: AutosaveStatus): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'failed' && right.kind === 'failed')
    return left.message === right.message;
  if (left.kind === 'conflict' && right.kind === 'conflict')
    return left.message === right.message;
  return true;
}

/**
 * Create the debounced, single-flight autosave state machine.
 *
 * The controller only ever calls `save()` after an edit marked it dirty, so a
 * clean document never reaches the Host. A save that fails or conflicts is not
 * retried automatically; the user (or the next edit) drives the retry.
 */
export function createAutosaveController(
  options: AutosaveControllerOptions,
): AutosaveController {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const draftIntervalMs = options.draftIntervalMs ?? DRAFT_WRITE_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());

  let pending = false;
  let blocked = false;
  let disposed = false;
  let saving: Promise<void> | null = null;
  let debounceTimer: TimerHandle | null = null;
  let draftTimer: TimerHandle | null = null;
  let lastDraftWriteAt = Number.NEGATIVE_INFINITY;
  let flushRequested = false;
  let status: AutosaveStatus = { kind: 'idle' };

  function setStatus(next: AutosaveStatus): void {
    if (disposed) return;
    if (sameStatus(status, next)) return;
    status = next;
    options.onStatus(next);
  }

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function clearDraftTimer(): void {
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  }

  function persistDraftNow(): void {
    clearDraftTimer();
    let payload: DocumentDraftPayload | undefined;
    try {
      payload = options.captureDraft();
    } catch {
      payload = undefined;
    }
    if (payload === undefined) return;
    try {
      options.writeDraft({ ...payload, savedAt: now() });
    } catch {
      // Draft writes must never break editing.
    }
    lastDraftWriteAt = now();
  }

  function scheduleDraftWrite(): void {
    if (disposed || draftTimer !== null) return;
    const elapsed = now() - lastDraftWriteAt;
    if (elapsed >= draftIntervalMs) {
      persistDraftNow();
      return;
    }
    draftTimer = setTimeout(() => {
      draftTimer = null;
      persistDraftNow();
    }, Math.max(0, draftIntervalMs - elapsed));
  }

  function scheduleDebounce(): void {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSave(false);
    }, debounceMs);
  }

  function applyOutcome(outcome: SaveOutcome): void {
    switch (outcome.kind) {
      case 'saved':
        options.clearDraft();
        // Edits made while the request was in flight are not part of this
        // receipt: keep a draft for them until the next cycle lands.
        if (pending) persistDraftNow();
        setStatus({ kind: 'idle' });
        break;
      case 'skipped':
        if (!pending) options.clearDraft();
        setStatus({ kind: 'idle' });
        break;
      case 'failed':
        pending = true;
        setStatus({ kind: 'failed', message: outcome.message });
        persistDraftNow();
        break;
      case 'conflict':
        pending = true;
        blocked = true;
        setStatus({ kind: 'conflict', message: outcome.message });
        persistDraftNow();
        break;
    }
  }

  async function runSave(immediate: boolean): Promise<void> {
    if (disposed) return;
    if (saving !== null) {
      if (immediate) flushRequested = true;
      await saving;
      return;
    }
    if (blocked || !pending) return;
    clearDebounce();
    pending = false;
    persistDraftNow();
    setStatus({ kind: 'saving' });
    saving = (async () => {
      let outcome: SaveOutcome;
      try {
        outcome = await options.save();
      } catch (error) {
        outcome = { kind: 'failed', message: describeSaveError(error) };
      }
      applyOutcome(outcome);
    })();
    try {
      await saving;
    } finally {
      saving = null;
    }
    if (disposed) return;
    if (blocked) {
      flushRequested = false;
      return;
    }
    if (!pending) {
      flushRequested = false;
      return;
    }
    if (flushRequested) {
      flushRequested = false;
      await runSave(true);
      return;
    }
    // A failed cycle waits for an explicit retry / the next edit instead of
    // hammering a down Host.
    if (status.kind !== 'failed') scheduleDebounce();
  }

  function notifyChange(): void {
    if (disposed) return;
    pending = true;
    scheduleDraftWrite();
    if (blocked || saving !== null) return;
    scheduleDebounce();
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    clearDebounce();
    if (blocked) blocked = false;
    if (pending) persistDraftNow();
    flushRequested = true;
    await runSave(true);
    flushRequested = false;
  }

  async function retry(): Promise<void> {
    if (disposed) return;
    clearDebounce();
    blocked = false;
    flushRequested = true;
    await runSave(true);
    flushRequested = false;
  }

  function reset(): void {
    clearDebounce();
    clearDraftTimer();
    pending = false;
    blocked = false;
    flushRequested = false;
    setStatus({ kind: 'idle' });
  }

  function fail(message: string): void {
    if (disposed) return;
    blocked = false;
    pending = true;
    persistDraftNow();
    setStatus({ kind: 'failed', message });
  }

  function dispose(): void {
    if (disposed) return;
    const hadPending = pending;
    if (hadPending) persistDraftNow();
    disposed = true;
    clearDebounce();
    clearDraftTimer();
    pending = false;
    if (!hadPending || saving !== null || blocked) return;
    // Switching documents must not drop the last edits: try one final save in
    // the background. The draft above is the guarantee if the page dies.
    void Promise.resolve()
      .then(() => options.save())
      .then((outcome) => {
        if (outcome.kind === 'saved') options.clearDraft();
      })
      .catch(() => undefined);
  }

  return {
    notifyChange,
    flush,
    retry,
    reset,
    persistDraftNow,
    fail,
    hasPending: () => pending,
    getStatus: () => status,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Save pipeline
// ---------------------------------------------------------------------------

/** Snapshot returned by `client.get` (only the fields the editor needs). */
export interface DocumentSnapshotLike {
  doc: AlterDoc;
  revision: number;
  title?: string;
}

/** Collaborators of one document save cycle. */
export interface DocumentSaverDeps {
  docId: string;
  client: Pick<SpaceDocumentClient, 'get' | 'applyOperations'>;
  /** Canonical document the current base revision corresponds to. */
  initialDoc: AlterDoc;
  baseRevision: number;
  initialTitle: string;
  /** Current Tiptap JSON (kept by the component on every update). */
  getEditorJson: () => JSONContent | undefined;
  /** Current controlled title value. */
  getTitle: () => string;
  /** Metadata-only title write (`space.saveNode`); omitted in pure tests. */
  saveTitle?: (title: string) => Promise<unknown>;
  /** Called after the Host confirmed (or reconciled) the content. */
  onSaved: (revision: number, doc: AlterDoc, title: string) => void;
  /** Diff hook (injectable for tests); defaults to `computeOperations`. */
  computeOps?: (oldDoc: AlterDoc, newDoc: AlterDoc) => Operation[];
  createIdempotencyKey?: () => string | undefined;
}

/** Handle returned by {@link createDocumentSaver}. */
export interface DocumentSaver {
  save(): Promise<SaveOutcome>;
  /** Adopt an externally loaded snapshot (reload, restore, reconciliation). */
  adopt(doc: AlterDoc, revision: number, title: string): void;
  context(): { baseRevision: number; savedRevision: number };
}

/** Read a Host `doc.get` snapshot defensively. */
export function readSnapshot(value: unknown): DocumentSnapshotLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const doc = record['doc'];
  if (typeof doc !== 'object' || doc === null) return undefined;
  const docRecord = doc as Record<string, unknown>;
  if (docRecord['format'] !== 'alter-doc/1') return undefined;
  if (!Array.isArray(docRecord['blocks'])) return undefined;
  const revision =
    readRevision(record) ?? readRevision(docRecord);
  if (revision === undefined) return undefined;
  const title = record['title'];
  return {
    doc: doc as AlterDoc,
    revision,
    ...(typeof title === 'string' ? { title } : {}),
  };
}

/** Read a non-negative integer revision from an RPC result. */
export function readRevision(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const revision = (value as Record<string, unknown>)['revision'];
  return typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 0
    ? revision
    : undefined;
}

/** Turn any thrown value into a readable Chinese save error. */
export function describeSaveError(error: unknown): string {
  if (error instanceof DocumentDiffError) return error.message;
  if (error instanceof SpaceRemoteError) {
    switch (error.code) {
      case 'doc/conflict':
        return '文档已被其他修改（revision 冲突）。本地内容已保留。';
      case 'doc/not-found':
        return '文档不存在或已被删除，请刷新页面后重试。';
      case 'doc/too-large':
        return '文档超过服务端体量上限，无法保存。请精简内容后重试。';
      case 'doc/schema-invalid':
      case 'node/schema-invalid':
        return `文档结构未通过服务端校验：${error.message}`;
      case 'node/not-found':
        return '编辑期间部分块已被其他操作删除，请重新加载后再保存。';
      case 'node/not-writable':
        return `当前节点类型不允许该修改：${error.message}`;
      case 'node/unsupported-transform':
        return `不支持该节点类型转换：${error.message}`;
      case 'op/invalid':
        return `保存操作未被服务端接受：${error.message}`;
      case 'idempotency/conflict':
        return '保存请求与之前的重复请求不一致，请重新加载后再保存。';
      default:
        return `保存失败：${error.message}`;
    }
  }
  if (error instanceof Error) {
    if (error.message.includes('变更过大')) return error.message;
    return `保存失败：${error.message}`;
  }
  return '保存失败：未知错误';
}

function describeEditError(error: unknown): string {
  if (error instanceof DocumentDiffError) return error.message;
  if (error instanceof Error) return `无法生成保存操作：${error.message}`;
  return '无法生成保存操作：未知错误';
}

function describeTitleError(error: unknown): string {
  if (error instanceof Error) return `标题保存失败：${error.message}`;
  return '标题保存失败：未知错误';
}

function createIdempotencyKey(): string | undefined {
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  return typeof cryptoApi?.randomUUID === 'function'
    ? `editor-${cryptoApi.randomUUID()}`
    : undefined;
}

/**
 * Create the save pipeline for one document.
 *
 * The saver owns the "what does the Host already have" baseline
 * (`lastSavedDoc` + revision); the component only supplies the live editor
 * state and receives `onSaved` after a confirmed write. Title writes go first
 * (metadata-only `space.saveNode`), then the body diff goes through Document
 * Operations.
 */
export function createDocumentSaver(deps: DocumentSaverDeps): DocumentSaver {
  let lastSavedDoc = deps.initialDoc;
  let baseRevision = deps.baseRevision;
  let savedRevision = deps.baseRevision;
  let lastSavedTitle = normalizeTitle(deps.initialTitle);
  let pendingKey:
    | { signature: string; baseRevision: number; key: string | undefined }
    | null = null;

  function adopt(doc: AlterDoc, revision: number, title: string): void {
    lastSavedDoc = doc;
    baseRevision = revision;
    savedRevision = revision;
    lastSavedTitle = normalizeTitle(title);
    pendingKey = null;
  }

  async function reconcileConflict(intended: AlterDoc): Promise<SaveOutcome> {
    let snapshot: DocumentSnapshotLike | undefined;
    try {
      snapshot = readSnapshot(await deps.client.get(deps.docId));
    } catch (error) {
      return { kind: 'failed', message: describeSaveError(error) };
    }
    if (snapshot === undefined) {
      return {
        kind: 'conflict',
        message: '保存冲突，且无法读取服务端最新内容。本地内容已保留为草稿。',
      };
    }
    if (blocksContentEquivalent(snapshot.doc.blocks, intended.blocks)) {
      // The write actually landed (or someone wrote identical content): treat
      // it as saved instead of reporting a phantom conflict.
      const savedDoc: AlterDoc = { ...intended, revision: snapshot.revision };
      lastSavedDoc = savedDoc;
      baseRevision = snapshot.revision;
      savedRevision = snapshot.revision;
      pendingKey = null;
      deps.onSaved(snapshot.revision, savedDoc, lastSavedTitle);
      return { kind: 'saved', revision: snapshot.revision };
    }
    pendingKey = null;
    return {
      kind: 'conflict',
      message: `文档已被其他修改（服务端 revision ${snapshot.revision}）。本地内容已保留为草稿。`,
      serverRevision: snapshot.revision,
    };
  }

  async function save(): Promise<SaveOutcome> {
    const editorJson = deps.getEditorJson();
    if (editorJson === undefined) return { kind: 'skipped' };
    const title = normalizeTitle(deps.getTitle());
    const titleChanged = title !== '' && title !== lastSavedTitle;

    let newDoc: AlterDoc;
    try {
      newDoc = {
        format: 'alter-doc/1',
        schemaVersion: lastSavedDoc.schemaVersion,
        revision: baseRevision,
        blocks: tiptapToBlocks(editorJson),
      };
    } catch (error) {
      return { kind: 'failed', message: describeEditError(error) };
    }

    let ops: Operation[];
    try {
      ops = (deps.computeOps ?? computeOperations)(lastSavedDoc, newDoc);
    } catch (error) {
      return { kind: 'failed', message: describeEditError(error) };
    }
    if (!titleChanged && ops.length === 0) return { kind: 'skipped' };

    if (titleChanged) {
      if (deps.saveTitle !== undefined) {
        try {
          await deps.saveTitle(title);
        } catch (error) {
          return { kind: 'failed', message: describeTitleError(error) };
        }
      }
      lastSavedTitle = title;
    }

    if (ops.length === 0) {
      // Title-only save: revision does not move, but the view still needs the
      // canonical snapshot so its header stays in sync.
      deps.onSaved(baseRevision, lastSavedDoc, lastSavedTitle);
      return { kind: 'saved', revision: baseRevision };
    }

    const signature = JSON.stringify(ops);
    if (
      pendingKey === null ||
      pendingKey.baseRevision !== baseRevision ||
      pendingKey.signature !== signature
    ) {
      pendingKey = {
        signature,
        baseRevision,
        key: (deps.createIdempotencyKey ?? createIdempotencyKey)(),
      };
    }
    try {
      const result = await deps.client.applyOperations({
        docId: deps.docId,
        baseRevision,
        ops,
        idempotencyKey: pendingKey.key,
      });
      const revision = readRevision(result) ?? baseRevision + 1;
      const savedDoc: AlterDoc = { ...newDoc, revision };
      lastSavedDoc = savedDoc;
      baseRevision = revision;
      savedRevision = revision;
      pendingKey = null;
      deps.onSaved(revision, savedDoc, lastSavedTitle);
      return { kind: 'saved', revision };
    } catch (error) {
      if (error instanceof SpaceRemoteError && error.code === 'doc/conflict') {
        return reconcileConflict(newDoc);
      }
      if (error instanceof SpaceRemoteError && error.code === 'idempotency/conflict') {
        // A stale key from a previous attempt; retry with a fresh one.
        pendingKey = null;
      }
      return { kind: 'failed', message: describeSaveError(error) };
    }
  }

  return {
    save,
    adopt,
    context: () => ({ baseRevision, savedRevision }),
  };
}
