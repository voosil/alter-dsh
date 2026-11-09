import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Archive, Brush, FileText, Search, X } from 'lucide-react';
import type { SearchResult } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { docPath, thoughtsPath } from '../space-route';
import { displayTitle } from '../utils/tree';
import { Input, IconButton } from '@alter/ui-system';
import styles from './SearchPanel.module.css';

function optionId(type: 'doc' | 'thought', id: string) {
  return `search-option-${type}-${id}`;
}

export function SearchPanel({
  open,
  onClose,
  onSelectDocument,
}: {
  open: boolean;
  onClose: () => void;
  onSelectDocument?: (id: string) => void;
}) {
  const { service, router, spaceId, nodes } = useSpaceContext();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const text = query.trim();
    if (!text) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void service.search(spaceId, text).then((items) => {
        if (!alive) return;
        setResults(items);
        setActive(0);
      });
    }, 90);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, service, spaceId]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent | globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const recent = useMemo(
    () =>
      [...nodes]
        .filter((node) => node.kind === 'note' && !node.archived)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 5),
    [nodes],
  );

  const docs = results.filter((item) => item.type === 'doc');
  const thoughts = onSelectDocument
    ? []
    : results.filter((item) => item.type === 'thought');
  const ordered = [...docs, ...thoughts];
  const searching = Boolean(query.trim());
  const entryCount = searching ? ordered.length : recent.length;
  const activeId = searching
    ? ordered[active]
      ? optionId(ordered[active].type, ordered[active].id)
      : undefined
    : recent[active]
      ? optionId('doc', recent[active].id)
      : undefined;

  useEffect(() => {
    panelRef.current
      ?.querySelector('[data-search-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, query, results]);

  if (!open) return null;

  function openResult(result: SearchResult) {
    onClose();
    if (onSelectDocument && result.type === 'doc') {
      onSelectDocument(result.id);
      return;
    }
    router.navigate(
      result.type === 'doc'
        ? docPath(spaceId, result.id)
        : thoughtsPath(spaceId, result.id),
    );
  }

  function openRecent(id: string) {
    onClose();
    if (onSelectDocument) {
      onSelectDocument(id);
      return;
    }
    router.navigate(docPath(spaceId, id));
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (entryCount) setActive((index) => Math.min(entryCount - 1, index + 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (entryCount) setActive((index) => Math.max(0, index - 1));
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    }
    if (event.key === 'End') {
      event.preventDefault();
      if (entryCount) setActive(entryCount - 1);
    }
    if (event.key === 'Enter') {
      if (searching && ordered[active]) {
        event.preventDefault();
        openResult(ordered[active]);
      } else if (!searching && recent[active]) {
        event.preventDefault();
        openRecent(recent[active].id);
      }
    }
  }

  function renderResult(result: SearchResult, index: number) {
    return (
      <button
        type="button"
        key={`${result.type}-${result.id}`}
        id={optionId(result.type, result.id)}
        role="option"
        aria-selected={index === active}
        data-search-active={index === active || undefined}
        className={styles.result}
        onMouseEnter={() => setActive(index)}
        onClick={() => openResult(result)}
      >
        <span className={styles.resultIcon} aria-hidden="true">
          {result.type === 'doc' ? (
            <FileText size={16} strokeWidth={1.5} />
          ) : (
            <Brush size={16} strokeWidth={1.5} />
          )}
        </span>
        <span className={styles.resultText}>
          <span className={styles.resultTitle}>
            {displayTitle(result.title)}
            {result.archived ? (
              <span className={styles.badge}>
                <Archive size={10} strokeWidth={1.7} aria-hidden="true" />
                已归档
              </span>
            ) : null}
          </span>
          <span className={styles.excerpt}>{result.excerpt}</span>
        </span>
      </button>
    );
  }

  return createPortal(
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-label="搜索空间"
      >
        <div className={styles.inputRow}>
          <Search
            size={17}
            strokeWidth={1.6}
            className={styles.searchIcon}
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={onSelectDocument ? '搜索文档' : '搜索文档和随想'}
            aria-label={onSelectDocument ? '搜索文档' : '搜索文档和随想'}
            role="combobox"
            aria-expanded="true"
            aria-controls="space-search-results"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoComplete="off"
          />
          <IconButton
            label="关闭搜索"
            icon={<X size={15} strokeWidth={1.7} />}
            onClick={onClose}
          />
        </div>
        <div
          className={styles.results}
          role="listbox"
          id="space-search-results"
          aria-label="搜索结果"
        >
          {query.trim() ? (
            ordered.length ? (
              <>
                {docs.length ? (
                  <>
                    <div className={styles.groupLabel}>文档</div>
                    {docs.map((result) =>
                      renderResult(result, ordered.indexOf(result)),
                    )}
                  </>
                ) : null}
                {thoughts.length ? (
                  <>
                    <div className={styles.groupLabel}>随想</div>
                    {thoughts.map((result) =>
                      renderResult(result, ordered.indexOf(result)),
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <p className={styles.empty}>没有找到「{query.trim()}」</p>
            )
          ) : recent.length ? (
            <>
              <div className={styles.groupLabel}>最近更新</div>
              {recent.map((node, index) => (
                <button
                  type="button"
                  key={node.id}
                  id={optionId('doc', node.id)}
                  role="option"
                  aria-selected={index === active}
                  data-search-active={index === active || undefined}
                  className={styles.result}
                  data-single-line="true"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => openRecent(node.id)}
                >
                  <span className={styles.resultIcon} aria-hidden="true">
                    <FileText size={16} strokeWidth={1.5} />
                  </span>
                  <span className={styles.resultText}>
                    <span className={styles.resultTitle}>
                      {displayTitle(node.title)}
                    </span>
                  </span>
                </button>
              ))}
            </>
          ) : (
            <p className={styles.empty}>
              输入关键词，搜索当前空间的文档和随想。
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
