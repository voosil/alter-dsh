/**
 * Modal picker for inserting one built-in declarative component.
 *
 * The dialog is presentational: the editor surface owns insertion (the
 * two-batch Document-Operations flow) and its error state.
 *
 * @module @alter-dsh/space/document/components/ComponentPicker
 */
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { COMPONENT_CATALOG } from '@alter/protocol';
import styles from './components.module.css';

/** Props of the component picker dialog. */
export interface ComponentPickerProps {
  /** Whether the dialog is mounted. */
  open: boolean;
  /** A two-batch insertion is in flight. */
  busy?: boolean;
  /** Insertion error owned by the editor surface. */
  error?: string | null;
  onSelect: (componentId: string) => void;
  onClose: () => void;
}

/** Catalog list dialog used by the slash menu's 「插入组件」 command. */
export function ComponentPicker({
  open,
  busy = false,
  error = null,
  onSelect,
  onClose,
}: ComponentPickerProps): ReactNode {
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className={styles.overlay} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="插入组件"
      >
        <div className={styles.header}>
          <span className={styles.title}>插入组件</span>
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
        </div>
        <div className={styles.body}>
          <p className={styles.hint}>
            仅支持内置声明式组件：文档只保存组件 id 与 props，不执行任意代码。
          </p>
          <div className={styles.catalog}>
            {COMPONENT_CATALOG.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className={styles.catalogItem}
                disabled={busy}
                onClick={() => onSelect(definition.id)}
              >
                <span className={styles.catalogName}>{definition.name}</span>
                <span className={styles.catalogId}>{definition.id}</span>
                <span className={styles.catalogDesc}>
                  {definition.description}
                </span>
              </button>
            ))}
          </div>
          {error === null ? null : (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
