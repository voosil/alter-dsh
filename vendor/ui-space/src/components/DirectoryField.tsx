import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Check, ChevronRight, Folder, FolderPlus, X } from 'lucide-react';
import type { DirectoryListing } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { Popover } from '@alter/ui-system';
import styles from './DirectoryField.module.css';

const HOME_PATH = '~';
const HOME_LABEL = '主目录';

function segmentsOf(path: string) {
  return path === HOME_PATH ? [] : path.slice(HOME_PATH.length + 1).split('/');
}

function directoryName(path: string) {
  if (path === HOME_PATH) return HOME_LABEL;
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function DirectoryField({
  directories,
  onChange,
}: {
  directories: string[];
  onChange: (next: string[]) => void;
}) {
  const { service } = useSpaceContext();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const [path, setPath] = useState(HOME_PATH);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstEntryRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const currentCrumbRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const requestRef = useRef(0);
  const focusOnLoadRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const wasOpenRef = useRef(false);
  const hintId = useId();

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      focusOnLoadRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const active = document.activeElement;
    if (!restoreFocusRef.current && active && active !== document.body) return;
    restoreFocusRef.current = false;
    const frame = requestAnimationFrame(() => triggerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /**
   * Escape must always return focus to the trigger. The popover uses a virtual
   * anchor, so Radix has no trigger to restore focus to, and focus may sit on
   * the outer dialog while the directory listing is still loading.
   */
  useEffect(() => {
    if (!open) return;
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      restoreFocusRef.current = true;
      setOpen(false);
    }
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [open]);

  useEffect(() => {
    if (!open || loading || !focusOnLoadRef.current) return;
    focusOnLoadRef.current = false;
    if (error) {
      retryRef.current?.focus();
      return;
    }
    if (!listing) return;
    if (listing.entries.length) {
      firstEntryRef.current?.focus({ preventScroll: true });
      return;
    }
    const target = chooseRef.current;
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else currentCrumbRef.current?.focus({ preventScroll: true });
  }, [open, loading, error, listing]);

  useEffect(() => {
    if (!open) return;
    const node = crumbsRef.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [open, path, listing]);

  async function load(nextPath: string) {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await service.listDirectories(nextPath);
      if (requestRef.current !== request) return;
      setListing(result);
      setLoading(false);
    } catch (cause) {
      if (requestRef.current !== request) return;
      setListing(null);
      setLoading(false);
      setError(cause instanceof Error ? cause.message : '无法读取目录');
    }
  }

  function openPicker() {
    focusOnLoadRef.current = true;
    setListing(null);
    setOpen(true);
    void load(path);
  }

  function navigate(next: string, focusFirstEntry: boolean) {
    if (next === path) return;
    focusOnLoadRef.current = focusFirstEntry;
    setListing(null);
    setPath(next);
    void load(next);
  }

  function chooseCurrent() {
    if (!listing || directories.includes(listing.path)) return;
    onChange([...directories, listing.path]);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function removeDirectory(target: string) {
    onChange(directories.filter((item) => item !== target));
    triggerRef.current?.focus();
  }

  function handleEntriesKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === 'ArrowDown'
        ? Math.min(buttons.length - 1, index + 1)
        : Math.max(0, index - 1);
    buttons[next]?.focus();
  }

  function handlePickerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ),
    ].filter((item) => item.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const crumbs = [
    { label: HOME_LABEL, path: HOME_PATH },
    ...segmentsOf(path).map((name, index, all) => ({
      label: name,
      path: `${HOME_PATH}/${all.slice(0, index + 1).join('/')}`,
    })),
  ];
  const displayPath = path === HOME_PATH ? HOME_LABEL : path;
  const alreadyAdded = listing ? directories.includes(listing.path) : false;

  return (
    <div className={styles.root} role="group" aria-label="工作目录">
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
                onClick={() => removeDirectory(directory)}
              >
                <X size={13} strokeWidth={1.7} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.actions}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.add}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-describedby={hintId}
          onClick={(event) => {
            if (open) {
              setOpen(false);
              return;
            }
            setAnchor(event.currentTarget);
            openPicker();
          }}
        >
          <FolderPlus size={14} strokeWidth={1.7} aria-hidden="true" />
          选择目录
        </button>
        <span id={hintId} className={styles.hint}>
          可以选择多个目录
        </span>
      </div>

      <div ref={setPortalHost} />
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={336}
        role="dialog"
        ariaLabel="选择目录"
        layer="modal"
        flush
        container={portalHost}
        className={styles.picker}
      >
        <div className={styles.pickerBody} onKeyDown={handlePickerKeyDown}>
          <nav ref={crumbsRef} className={styles.crumbs} aria-label="目录路径">
            {crumbs.map((crumb, index) => {
              const current = index === crumbs.length - 1;
              return (
                <Fragment key={crumb.path}>
                  {index > 0 ? (
                    <span className={styles.separator} aria-hidden="true">
                      /
                    </span>
                  ) : null}
                  <button
                    type="button"
                    ref={current ? currentCrumbRef : undefined}
                    className={styles.crumb}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => navigate(crumb.path, false)}
                  >
                    {crumb.label}
                  </button>
                </Fragment>
              );
            })}
          </nav>
          <div
            className={styles.entries}
            role="group"
            aria-label="子目录"
            aria-busy={loading}
            onKeyDown={handleEntriesKeyDown}
          >
            {loading ? (
              <p className={styles.state} role="status">
                正在读取…
              </p>
            ) : null}
            {!loading && error ? (
              <div className={styles.state} role="alert">
                <span>{error}</span>
                <button
                  ref={retryRef}
                  type="button"
                  className={styles.retry}
                  onClick={() => {
                    focusOnLoadRef.current = true;
                    void load(path);
                  }}
                >
                  重试
                </button>
              </div>
            ) : null}
            {!loading && !error && listing?.entries.length === 0 ? (
              <p className={styles.state}>这个目录下没有子目录。</p>
            ) : null}
            {!loading && !error
              ? listing?.entries.map((entry, index) => {
                  const selected = directories.includes(entry.path);
                  return (
                    <button
                      key={entry.path}
                      ref={index === 0 ? firstEntryRef : undefined}
                      type="button"
                      className={styles.entry}
                      title={entry.path}
                      aria-label={`进入 ${entry.name}${selected ? '，已添加' : ''}`}
                      onClick={() => navigate(entry.path, true)}
                    >
                      <Folder
                        size={15}
                        strokeWidth={1.6}
                        className={styles.folderIcon}
                        aria-hidden="true"
                      />
                      <span className={styles.entryName}>{entry.name}</span>
                      {selected ? (
                        <Check
                          size={13}
                          strokeWidth={2.2}
                          className={styles.entryCheck}
                          aria-hidden="true"
                        />
                      ) : null}
                      <ChevronRight
                        size={14}
                        strokeWidth={1.6}
                        className={styles.chevron}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })
              : null}
          </div>
          <div className={styles.footer}>
            <span className={styles.footerPath} title={displayPath}>
              {displayPath}
            </span>
            <button
              ref={chooseRef}
              type="button"
              className={styles.choose}
              disabled={loading || !listing || alreadyAdded}
              onClick={chooseCurrent}
            >
              {alreadyAdded ? '已添加' : '选择此目录'}
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
