/**
 * Built-in declarative component renderers.
 *
 * Every renderer is a plain React component over validated props: no eval, no
 * remote code, no iframe. The renderer map is the browser half of the catalog
 * in `@alter/protocol`; a catalog id without an entry degrades to a card in
 * `registry.tsx`.
 *
 * @module @alter-dsh/space/document/components/renderers
 */
import { useState, type ReactNode } from 'react';
import type { ComponentPayload, JsonValue } from '@alter/protocol';
import styles from './components.module.css';

/** Props shared by every built-in renderer. */
export interface ComponentRenderProps {
  payload: ComponentPayload;
  /** Preview inside a read-only editor: interactive parts stay inert. */
  readOnly?: boolean;
}

function stringProp(payload: ComponentPayload, key: string): string {
  const value = payload.props[key];
  return typeof value === 'string' ? value : '';
}

function numberProp(
  payload: ComponentPayload,
  key: string,
  fallback: number,
): number {
  const value = payload.props[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function listProp(payload: ComponentPayload, key: string): string[] {
  const value = payload.props[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Progress bar: label + 0–100 bar + value. */
export function ProgressComponent({
  payload,
}: ComponentRenderProps): ReactNode {
  const label = stringProp(payload, 'label');
  const raw = numberProp(payload, 'value', 0);
  const value = Math.min(100, Math.max(0, Math.round(raw)));
  return (
    <div className={styles.progress} data-component="progress">
      <div className={styles.progressHead}>
        <span className={styles.progressLabel}>{label}</span>
        <span className={styles.progressValue}>{value}%</span>
      </div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div className={styles.progressBar} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/** Checklist with local-only check state (v1 never persists interactions). */
export function ChecklistComponent({
  payload,
  readOnly = false,
}: ComponentRenderProps): ReactNode {
  const title = stringProp(payload, 'title');
  const items = listProp(payload, 'items');
  const [checked, setChecked] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const toggle = (index: number): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  return (
    <div className={styles.checklist} data-component="checklist">
      <div className={styles.checklistTitle}>{title}</div>
      <ul className={styles.checklistItems}>
        {items.map((item, index) => {
          const done = checked.has(index);
          return (
            <li key={index} className={styles.checklistItem}>
              <label className={styles.checklistLabel}>
                <input
                  type="checkbox"
                  checked={done}
                  disabled={readOnly}
                  aria-label={item}
                  onChange={() => toggle(index)}
                />
                <span
                  className={done ? styles.checklistTextDone : undefined}
                  data-checked={done ? 'true' : 'false'}
                >
                  {item}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className={styles.checklistHint}>勾选状态仅本地预览，不写入文档</div>
    </div>
  );
}

/** Single metric card: label, value and optional hint. */
export function StatComponent({ payload }: ComponentRenderProps): ReactNode {
  const label = stringProp(payload, 'label');
  const value = stringProp(payload, 'value');
  const hint = stringProp(payload, 'hint');
  return (
    <div className={styles.stat} data-component="stat">
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {hint === '' ? null : <div className={styles.statHint}>{hint}</div>}
    </div>
  );
}

/** Renderer map keyed by catalog id. */
export const COMPONENT_RENDERERS: Record<
  string,
  (props: ComponentRenderProps) => ReactNode
> = {
  'builtin/progress': ProgressComponent,
  'builtin/checklist': ChecklistComponent,
  'builtin/stat': StatComponent,
};

/** Props of one component payload, typed for renderers/tests. */
export type ComponentProps = Record<string, JsonValue>;
