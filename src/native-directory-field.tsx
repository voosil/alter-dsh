/**
 * Port-owned replacement for the vendored working-directory field.
 *
 * Upstream `vendor/ui-space/src/components/DirectoryField.tsx` browses
 * directories through the Space RPC (`service.listDirectories`) in a hand-made
 * popover. The DSH port opens the **host directory picker** instead
 * (`ctx.uiWorkspace.pickDirectory()`), so the desktop app shows its native
 * folder dialog and the browser profile shows the DSH browse dialog — exactly
 * the picker DSH's own "add workspace" flow uses.
 *
 * `vendor/` stays byte-identical: `build/build.mjs` redirects the two vendored
 * import sites (`CreateSpaceDialog`, `ConfigView`) here at bundle time. The
 * provider is installed by `src/space-shell.tsx`; when the host exposes no
 * picker (or the picker reports itself unavailable) this component falls back
 * to the original in-app browser so the Space feature keeps working.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import { DirectoryField as BrowserDirectoryField } from '../vendor/ui-space/src/components/DirectoryField';
import styles from '../vendor/ui-space/src/components/DirectoryField.module.css';
import portStyles from './native-directory-field.module.css';

/** Opens the host directory picker; resolves to an absolute path or null. */
export type DirectoryPicker = () => Promise<string | null>;

/** Stable code the entry half uses when the host has no directory picker. */
export const DIRECTORY_PICKER_UNAVAILABLE = 'directory-picker-unavailable';

const DirectoryPickerContext = createContext<DirectoryPicker | null>(null);

/** Install the host picker for every vendored directory field on the panel. */
export function DirectoryPickerProvider({
  pickDirectory,
  children,
}: {
  pickDirectory?: DirectoryPicker;
  children: ReactNode;
}) {
  return (
    <DirectoryPickerContext.Provider value={pickDirectory ?? null}>
      {children}
    </DirectoryPickerContext.Provider>
  );
}

function directoryName(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Append one picked path: trimmed, no duplicates, empty paths ignored.
 * @param directories - current selection.
 * @param picked - path returned by the picker.
 */
export function appendPickedDirectory(
  directories: readonly string[],
  picked: string,
): readonly string[] {
  const path = picked.trim();
  if (path === '' || directories.includes(path)) return directories;
  return [...directories, path];
}

function isPickerUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DIRECTORY_PICKER_UNAVAILABLE
  );
}

interface DirectoryFieldProps {
  directories: string[];
  onChange: (next: string[]) => void;
}

/**
 * Working-directory field: selected chips plus one picker trigger that opens
 * the host dialog directly. The first pick is labelled 「选择工作区」 (it
 * becomes the DSH workspace directory) and later picks 「选择资料库」.
 */
export function DirectoryField({ directories, onChange }: DirectoryFieldProps) {
  const pickDirectory = useContext(DirectoryPickerContext);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [browserFallback, setBrowserFallback] = useState(false);

  // Host without any picker, or one that reported itself unavailable mid-way.
  if (pickDirectory === null || browserFallback) {
    return (
      <BrowserDirectoryField directories={directories} onChange={onChange} />
    );
  }

  /**
   * The first directory becomes the Space's primary working directory (the one
   * mapped to a DSH workspace); every later pick is a reference source.
   */
  const selectingPrimary = directories.length === 0;

  async function choose(): Promise<void> {
    if (picking) return;
    setPicking(true);
    setError('');
    try {
      const picked = await pickDirectory!();
      if (picked === null) return;
      const next = appendPickedDirectory(directories, picked);
      if (next !== directories) onChange([...next]);
    } catch (cause) {
      if (isPickerUnavailable(cause)) {
        // Keep the feature usable on hosts without a directory picker.
        setBrowserFallback(true);
        return;
      }
      setError(cause instanceof Error ? cause.message : '无法打开系统目录选择');
    } finally {
      setPicking(false);
    }
  }

  return (
    <div
      className={styles.root}
      role="group"
      aria-label="工作目录"
      data-directory-picker="native"
    >
      {directories.length ? (
        <ul className={styles.selected} aria-label="已选目录">
          {directories.map((directory) => (
            <li key={directory} className={styles.selectedItem}>
              <Folder
                size={14}
                strokeWidth={1.5}
                className={styles.folderIcon}
                aria-hidden="true"
              />
              <span className={styles.selectedText}>
                <span className={styles.selectedName}>
                  {directoryName(directory)}
                </span>
                <span className={styles.selectedPath} title={directory}>
                  {directory}
                </span>
              </span>
              <button
                type="button"
                className={styles.remove}
                aria-label={`移除 ${directory}`}
                onClick={() =>
                  onChange(directories.filter((item) => item !== directory))
                }
              >
                <X size={13} strokeWidth={1.7} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.add}
          aria-haspopup="dialog"
          aria-busy={picking || undefined}
          disabled={picking}
          onClick={() => {
            void choose();
          }}
        >
          <FolderPlus size={14} strokeWidth={1.7} aria-hidden="true" />
          {picking
            ? '正在选择…'
            : selectingPrimary
              ? '选择工作区'
              : '选择资料库'}
        </button>
        <span className={styles.hint}>
          工作目录可编辑和读写，其他目录将作为资料库来源
        </span>
      </div>
      {error ? (
        <p className={portStyles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
