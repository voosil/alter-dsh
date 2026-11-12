/**
 * Save lifecycle controller for the document page (kernel-independent).
 *
 * Both editor kernels keep the 700ms silent autosave and its
 * 「保存失败，重试」button; this controller owns the state machine behind that
 * UI on top of the AST backend:
 *
 * - 700ms debounce, single-flight saves; edits made during a request mark the
 *   controller dirty and are saved by the next cycle (A3);
 * - every cycle captures canonical AST blocks + title (the kernel decides how
 *   it produces them) and applies the block diff through Document Operations;
 * - retries of the same pending content reuse the same idempotency key (A5);
 * - a `doc/conflict` is reconciled against `doc.get` first: when the Host
 *   already stores the intended content the cycle counts as saved, otherwise
 *   the controller enters the conflict state and never overwrites silently
 *   (B1/B2/B3);
 * - crash drafts are written to localStorage (throttled 1s, forced on
 *   flush/visibility/pagehide/unmount) and cleared once a save lands with no
 *   newer edits (A1/A2/A5).
 *
 * @module @alter-dsh/space/document/runtime/save-controller
 */
import { SpaceRemoteError } from '../../client/rpc';
import type { AlterDoc, BlockNode } from '../types';
import {
  DocumentDiffError,
  computeOperations,
} from './operations';
import type { DocumentClient } from './client-types';
import {
  DRAFT_FORMAT,
  blocksContentEquivalent,
  clearDraft,
  defaultDraftStorage,
  normalizeTitle,
  writeDocumentDraft,
  type DocumentDraftPayload,
  type DraftStorage,
  type DocumentDraft,
} from './draft';
import {
  readDocumentSnapshot,
  readRevisionOf,
  type DocumentSnapshot,
} from './snapshot';

/** Idle delay after the last edit before a save is attempted. */
export const SAVE_DEBOUNCE_MS = 700;

/** Minimum interval between localStorage draft writes while typing. */
export const DRAFT_WRITE_INTERVAL_MS = 1000;

/** Visible save status (maps onto the legacy save-error button). */
export type DocumentSaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; message: string; serverRevision?: number };

/** One server document state the controller saves against. */
export interface DocumentSaveSnapshot {
  doc: AlterDoc;
  revision: number;
  title: string;
}

/** Result of one save cycle. */
export type SaveOutcome =
  | { kind: 'saved'; snapshot: DocumentSaveSnapshot }
  | { kind: 'skipped' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; message: string; serverRevision?: number };

/** Collaborators of one legacy save controller. */
export interface DocumentSaveControllerOptions {
  docId: string;
  /** Server state the editor was loaded from. */
  initial: DocumentSaveSnapshot;
  /** Document client getter (undefined while the model is not assembled). */
  getClient(): DocumentClient | undefined;
  /** Capture the live editor body as canonical AST blocks + title. */
  capture(): { blocks: BlockNode[]; title: string };
  onStatus(status: DocumentSaveStatus): void;
  /** Base revision/doc changed (own save, adoption, conflict rebase). */
  onBaseChanged?(snapshot: DocumentSaveSnapshot): void;
  /** One save was confirmed (own save or reconciled lost receipt). */
  onSaved?(snapshot: DocumentSaveSnapshot): void;
  /** A server snapshot must replace the editor content (reload/restore). */
  onExternalSnapshot?(snapshot: DocumentSaveSnapshot): void;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Metadata-only title write (`space.saveNode`). */
  saveTitle(title: string): Promise<void>;
  now?(): number;
  debounceMs?: number;
  draftIntervalMs?: number;
  storage?: DraftStorage;
  createIdempotencyKey?(): string | undefined;
}

/** Handle returned by {@link createDocumentSaveController}. */
export interface DocumentSaveController {
  /** Mark the editor dirty and schedule the debounced save + draft write. */
  notifyChange(): void;
  /** Save immediately (Cmd/Ctrl+S, blur, unmount, retry button). */
  flush(): Promise<void>;
  /** Leave a failed/conflict state and retry the pending content. */
  retry(): Promise<void>;
  /** Whether edits are waiting to be saved. */
  hasPending(): boolean;
  getStatus(): DocumentSaveStatus;
  getBase(): DocumentSaveSnapshot;
  /** Persist the current editor state as a crash draft (forced). */
  persistDraftNow(): void;
  /** Remove the persisted crash draft. */
  discardDraft(): void;
  /** Forget pending work and reset the status (external snapshot adoption). */
  reset(): void;
  /** Adopt a server snapshot as the new base (keeps the draft). */
  adopt(snapshot: DocumentSaveSnapshot): void;
  /** Rebase onto a newer server revision but keep local edits (conflict path). */
  adoptForOverwrite(snapshot: DocumentSaveSnapshot): void;
  /** Load the latest server snapshot and reload the editor. */
  reloadServerSnapshot(options?: {
    clearDraft?: boolean;
  }): Promise<DocumentSaveSnapshot | undefined>;
  /** Conflict path: keep local edits and save them over the latest revision. */
  keepLocalOverwrite(): Promise<void>;
  /** Snapshot of the current draft for "download draft" recovery. */
  exportDraft(): DocumentDraft | undefined;
  /** Persist a final draft and try one last save (unmount). */
  dispose(): void;
}

function sameStatus(
  left: DocumentSaveStatus,
  right: DocumentSaveStatus,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'failed' && right.kind === 'failed')
    return left.message === right.message;
  if (left.kind === 'conflict' && right.kind === 'conflict')
    return left.message === right.message;
  return true;
}

function createIdempotencyKey(): string | undefined {
  const cryptoApi = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  return typeof cryptoApi?.randomUUID === 'function'
    ? `legacy-save-${cryptoApi.randomUUID()}`
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
    if (error.message.trim() !== '') return error.message;
  }
  return '保存失败，请重试';
}

interface PendingKey {
  signature: string;
  baseRevision: number;
  key: string | undefined;
}

/**
 * Create the debounced, single-flight save controller for one legacy document.
 */
export function createDocumentSaveController(
  options: DocumentSaveControllerOptions,
): DocumentSaveController {
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  const draftIntervalMs =
    options.draftIntervalMs ?? DRAFT_WRITE_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const storage = options.storage ?? defaultDraftStorage();

  let base: DocumentSaveSnapshot = options.initial;
  let lastSavedTitle = normalizeTitle(options.initial.title);
  let pendingKey: PendingKey | null = null;

  let pending = false;
  let blocked = false;
  let disposed = false;
  let saving: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDraftWriteAt = Number.NEGATIVE_INFINITY;
  let flushRequested = false;
  let keepDraftOnSave = false;
  let status: DocumentSaveStatus = { kind: 'idle' };

  function setStatus(next: DocumentSaveStatus): void {
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

  function captureDraftPayload(): DocumentDraftPayload | undefined {
    try {
      const capture = options.capture();
      return {
        format: DRAFT_FORMAT,
        docId: options.docId,
        blocks: capture.blocks,
        title: capture.title,
        baseRevision: base.revision,
      };
    } catch {
      return undefined;
    }
  }

  function persistDraftNow(): void {
    clearDraftTimer();
    const payload = captureDraftPayload();
    if (payload === undefined) return;
    try {
      writeDocumentDraft({ ...payload, savedAt: now() }, storage);
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

  function applyBaseSnapshot(snapshot: DocumentSaveSnapshot): void {
    base = snapshot;
    lastSavedTitle = normalizeTitle(snapshot.title);
    pendingKey = null;
    options.onBaseChanged?.(snapshot);
  }

  async function readServerSnapshot(): Promise<
    DocumentSaveSnapshot | undefined
  > {
    const client = options.getClient();
    if (client === undefined) return undefined;
    try {
      const raw = readDocumentSnapshot(await client.get(options.docId));
      if (raw === undefined) return undefined;
      return {
        doc: raw.doc,
        revision: raw.revision,
        title: raw.title ?? base.title,
      };
    } catch {
      return undefined;
    }
  }

  async function reconcileConflict(
    target: AlterDoc,
  ): Promise<SaveOutcome> {
    const snapshot = await readServerSnapshot();
    if (snapshot === undefined) {
      pendingKey = null;
      return {
        kind: 'conflict',
        message:
          '保存冲突，且无法读取服务端最新内容。本地内容已保留为草稿。',
      };
    }
    if (blocksContentEquivalent(snapshot.doc.blocks, target.blocks)) {
      // The write actually landed (or someone wrote identical content): treat
      // it as saved instead of reporting a phantom conflict.
      applyBaseSnapshot(snapshot);
      options.onSaved?.(snapshot);
      return { kind: 'saved', snapshot };
    }
    pendingKey = null;
    return {
      kind: 'conflict',
      message: `文档已被其他修改（服务端 revision ${snapshot.revision}）。本地内容已保留为草稿。`,
      serverRevision: snapshot.revision,
    };
  }

  /**
   * One save cycle: capture → diff → apply → title.
   *
   * `capture` reports canonical AST blocks; asset upload happens while the
   * kernel inserts content, never during a save.
   */
  async function saveOnce(): Promise<SaveOutcome> {
    const client = options.getClient();
    if (client === undefined) {
      return {
        kind: 'failed',
        message: '文档模型客户端未装配：请刷新页面或重新安装插件',
      };
    }
    let capture: { blocks: BlockNode[]; title: string };
    try {
      // Materialize kernel-side assets first (no-op for AST-native kernels).
      capture = options.capture();
    } catch (error) {
      return { kind: 'failed', message: describeSaveError(error) };
    }
    const title = normalizeTitle(capture.title);
    const titleChanged = title !== lastSavedTitle;

    const target: AlterDoc = {
      format: 'alter-doc/1',
      schemaVersion: 1,
      revision: base.revision,
      blocks: capture.blocks,
    };
    let ops: ReturnType<typeof computeOperations>;
    try {
      ops = computeOperations(base.doc, target);
    } catch (error) {
      return { kind: 'failed', message: describeSaveError(error) };
    }
    if (!titleChanged && ops.length === 0) return { kind: 'skipped' };

    if (titleChanged) {
      try {
        await options.saveTitle(title);
      } catch (error) {
        return {
          kind: 'failed',
          message: `标题保存失败：${describeSaveError(error)}`,
        };
      }
      lastSavedTitle = title;
    }

    if (ops.length === 0) {
      // Title-only save: revision does not move, but the base title changes.
      const snapshot: DocumentSaveSnapshot = {
        doc: base.doc,
        revision: base.revision,
        title,
      };
      base = snapshot;
      options.onBaseChanged?.(snapshot);
      options.onSaved?.(snapshot);
      return { kind: 'saved', snapshot };
    }

    const signature = JSON.stringify(ops);
    if (
      pendingKey === null ||
      pendingKey.baseRevision !== base.revision ||
      pendingKey.signature !== signature
    ) {
      pendingKey = {
        signature,
        baseRevision: base.revision,
        key: (options.createIdempotencyKey ?? createIdempotencyKey)(),
      };
    }
    try {
      const result = await client.applyOperations({
        docId: options.docId,
        baseRevision: base.revision,
        ops,
        idempotencyKey: pendingKey.key,
      });
      const revision = readRevisionOf(result) ?? base.revision + 1;
      const snapshot: DocumentSaveSnapshot = {
        doc: { ...target, revision },
        revision,
        title,
      };
      applyBaseSnapshot(snapshot);
      options.onSaved?.(snapshot);
      return { kind: 'saved', snapshot };
    } catch (error) {
      if (error instanceof SpaceRemoteError && error.code === 'doc/conflict') {
        return reconcileConflict(target);
      }
      if (
        error instanceof SpaceRemoteError &&
        error.code === 'idempotency/conflict'
      ) {
        // A stale key from a previous attempt; retry with a fresh one.
        pendingKey = null;
      }
      return { kind: 'failed', message: describeSaveError(error) };
    }
  }

  function applyOutcome(outcome: SaveOutcome): void {
    switch (outcome.kind) {
      case 'saved':
        if (keepDraftOnSave) {
          // The draft written by `dispose` holds edits this receipt does not
          // cover; keep it until the document is reopened and reconciled.
          keepDraftOnSave = false;
        } else {
          clearDraft(options.docId, storage);
          // Edits made while the request was in flight are not part of this
          // receipt: keep a draft for them until the next cycle lands.
          if (pending) persistDraftNow();
        }
        setStatus({ kind: 'idle' });
        break;
      case 'skipped':
        if (!pending) clearDraft(options.docId, storage);
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
        setStatus({
          kind: 'conflict',
          message: outcome.message,
          ...(outcome.serverRevision === undefined
            ? {}
            : { serverRevision: outcome.serverRevision }),
        });
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
        outcome = await saveOnce();
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
    // A conflicted document stays gated until the user picks a resolution.
    // Releasing the gate here (the previous behaviour) resent the same content
    // against the same stale revision on every blur/unmount, failed again, and
    // — because the status did not change — reported nothing, so the user kept
    // typing over a conflict that had no visible signal. The draft is the
    // safety net until a real decision arrives.
    if (blocked) {
      if (pending) persistDraftNow();
      return;
    }
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
    keepDraftOnSave = false;
    setStatus({ kind: 'idle' });
  }

  function adopt(snapshot: DocumentSaveSnapshot): void {
    applyBaseSnapshot(snapshot);
    pending = false;
    blocked = false;
    flushRequested = false;
    setStatus({ kind: 'idle' });
  }

  function adoptForOverwrite(snapshot: DocumentSaveSnapshot): void {
    applyBaseSnapshot(snapshot);
    blocked = false;
    pending = true;
    setStatus({ kind: 'idle' });
  }

  async function reloadServerSnapshot(
    reloadOptions: { clearDraft?: boolean } = {},
  ): Promise<DocumentSaveSnapshot | undefined> {
    const snapshot = await readServerSnapshot();
    if (snapshot === undefined) return undefined;
    adopt(snapshot);
    if (reloadOptions.clearDraft === true) {
      clearDraft(options.docId, storage);
    }
    options.onExternalSnapshot?.(snapshot);
    return snapshot;
  }

  async function keepLocalOverwrite(): Promise<void> {
    const snapshot = await readServerSnapshot();
    if (snapshot === undefined) {
      setStatus({
        kind: 'failed',
        message: '无法读取服务端最新内容，本地内容已保留为草稿。',
      });
      persistDraftNow();
      return;
    }
    adoptForOverwrite(snapshot);
    await flush();
  }

  function exportDraft(): DocumentDraft | undefined {
    const payload = captureDraftPayload();
    return payload === undefined ? undefined : { ...payload, savedAt: now() };
  }

  function discardDraft(): void {
    clearDraft(options.docId, storage);
  }

  function dispose(): void {
    if (disposed) return;
    const hadPending = pending;
    if (hadPending) persistDraftNow();
    // No final save is issued below when a request is already in flight, so
    // its receipt must not clear the newer draft written just above.
    if (hadPending && saving !== null) keepDraftOnSave = true;
    disposed = true;
    clearDebounce();
    clearDraftTimer();
    pending = false;
    if (!hadPending || saving !== null || blocked) return;
    // Switching documents must not drop the last edits: try one final save in
    // the background. The draft above is the guarantee if the page dies.
    void Promise.resolve()
      .then(() => saveOnce())
      .then((outcome) => {
        if (outcome.kind === 'saved') {
          clearDraft(options.docId, storage);
        }
      })
      .catch(() => undefined);
  }

  return {
    notifyChange,
    flush,
    retry,
    hasPending: () => pending,
    getStatus: () => status,
    getBase: () => base,
    persistDraftNow,
    discardDraft,
    reset,
    adopt,
    adoptForOverwrite,
    reloadServerSnapshot,
    keepLocalOverwrite,
    exportDraft,
    dispose,
  };
}

/** Re-export the snapshot type for consumers of the controller. */
export type { DocumentSnapshot };

