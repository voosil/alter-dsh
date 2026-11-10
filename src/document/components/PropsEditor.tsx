/**
 * Props editor dialog for one declarative component instance.
 *
 * The form is generated from the catalog prop schema; on save the candidate
 * payload is validated against the same schema the Host uses, so the dialog
 * cannot write a payload `update_object` would reject. Saving itself goes
 * through Document Operations in the editor surface.
 *
 * @module @alter-dsh/space/document/components/PropsEditor
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  getComponentDefinition,
  validateComponentPayload,
  type ComponentPayload,
  type ComponentPropSpec,
  type JsonValue,
} from '@alter/protocol';
import styles from './components.module.css';

/** Props of the component props editor dialog. */
export interface PropsEditorProps {
  /** Whether the dialog is mounted. */
  open: boolean;
  /** Payload to edit; `null` while loading. */
  initial: ComponentPayload | null;
  /** The payload is being fetched. */
  loading?: boolean;
  /** The payload is being saved through `update_object`. */
  saving?: boolean;
  /** Save/load error owned by the editor surface. */
  error?: string | null;
  /** The last save hit `doc/conflict`; offer a document reload. */
  conflict?: boolean;
  onSave: (payload: ComponentPayload) => void;
  onClose: () => void;
  /** Reload the document after a conflict (editor surface owns the reload). */
  onReload?: () => void;
}

/** Raw form value of one prop (all inputs are strings in the DOM). */
type DraftValues = Record<string, string>;

function draftOf(payload: ComponentPayload): DraftValues {
  const draft: DraftValues = {};
  for (const [key, value] of Object.entries(payload.props)) {
    if (typeof value === 'string') draft[key] = value;
    else if (typeof value === 'number') draft[key] = String(value);
    else if (Array.isArray(value))
      draft[key] = value
        .filter((item): item is string => typeof item === 'string')
        .join('\n');
  }
  return draft;
}

/** Convert one raw form value back into the JSON prop value. */
function propValueOf(spec: ComponentPropSpec, raw: string): JsonValue {
  if (spec.type === 'number') {
    const trimmed = raw.trim();
    return trimmed === '' ? Number.NaN : Number(trimmed);
  }
  if (spec.type === 'stringList') {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  return raw;
}

/** Modal props form for one component instance. */
export function PropsEditor({
  open,
  initial,
  loading = false,
  saving = false,
  error = null,
  conflict = false,
  onSave,
  onClose,
  onReload,
}: PropsEditorProps): ReactNode {
  const [draft, setDraft] = useState<DraftValues>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const draftSourceRef = useRef<ComponentPayload | null>(null);

  // Adopt a freshly loaded payload once per object; reopening the same object
  // keeps the user's in-dialog edits.
  useEffect(() => {
    if (!open) {
      draftSourceRef.current = null;
      return;
    }
    if (initial === null) return;
    if (draftSourceRef.current === initial) return;
    draftSourceRef.current = initial;
    setDraft(draftOf(initial));
    setLocalError(null);
  }, [open, initial]);

  if (!open || typeof document === 'undefined') return null;

  const busy = loading || saving;
  const message = error ?? localError;
  const definition =
    initial === null ? undefined : getComponentDefinition(initial.componentId);

  const update = (key: string, value: string): void => {
    setLocalError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = (): void => {
    if (initial === null || definition === undefined) return;
    const props: Record<string, JsonValue> = {};
    for (const [key, spec] of Object.entries(definition.props)) {
      const raw = draft[key];
      if (raw === undefined) continue;
      // Clearing an optional field removes the prop instead of storing an
      // empty placeholder; required fields keep the raw value so validation
      // can report the gap.
      if (spec.required !== true && raw.trim() === '') continue;
      props[key] = propValueOf(spec, raw);
    }
    const candidate: ComponentPayload = { ...initial, props };
    const errors = validateComponentPayload(candidate);
    if (errors.length > 0) {
      setLocalError(errors.join('；'));
      return;
    }
    setLocalError(null);
    onSave(candidate);
  };

  const fields: ReactNode = (
    <div className={styles.fields}>
      {definition === undefined
        ? null
        : Object.entries(definition.props).map(([key, spec]) => (
            <label key={key} className={styles.field}>
              <span className={styles.fieldLabel}>
                {spec.label}
                {spec.required === true ? ' *' : ''}
              </span>
              {spec.type === 'stringList' ? (
                <textarea
                  className={styles.textarea}
                  aria-label={spec.label}
                  rows={4}
                  value={draft[key] ?? ''}
                  disabled={busy}
                  onChange={(event) => update(key, event.target.value)}
                />
              ) : (
                <input
                  className={styles.input}
                  aria-label={spec.label}
                  type={spec.type === 'number' ? 'number' : 'text'}
                  value={draft[key] ?? ''}
                  disabled={busy}
                  onChange={(event) => update(key, event.target.value)}
                />
              )}
            </label>
          ))}
    </div>
  );

  return createPortal(
    <div className={styles.overlay} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="编辑组件"
      >
        <div className={styles.header}>
          <span className={styles.title}>
            {definition === undefined
              ? '编辑组件'
              : `编辑组件 · ${definition.name}`}
          </span>
          <span className={styles.counter}>
            {definition === undefined ? '' : definition.id}
          </span>
        </div>
        <div className={styles.body}>
          {initial === null ? (
            <div className={styles.hint}>
              {loading ? '正在加载组件…' : '组件对象不可用'}
            </div>
          ) : definition === undefined ? (
            <div className={styles.error} role="alert">
              未知组件：{initial.componentId}
            </div>
          ) : (
            fields
          )}
          {message === null ? null : (
            <div className={styles.error} role="alert">
              {message}
            </div>
          )}
        </div>
        <div className={styles.footer}>
          {conflict && onReload !== undefined ? (
            <button
              type="button"
              className={styles.button}
              onClick={onReload}
              disabled={busy}
            >
              重新加载文档
            </button>
          ) : null}
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={submit}
            disabled={busy || initial === null || definition === undefined}
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
