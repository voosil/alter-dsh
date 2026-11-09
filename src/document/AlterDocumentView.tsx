import { useEffect, useState } from 'react';
import type { SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../../vendor/ui-space/src/runtime';
import { documentClientOf } from './client-access';
import { AlterTiptapEditor } from './editor';
import { DocumentSidePanel } from './DocumentSidePanel';
import type { DocumentSnapshot } from './types';
import styles from './AlterDocumentView.module.css';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: DocumentSnapshot };

/**
 * Read-only renderer for AST-backed Space documents.
 *
 * Editing, comments and history remain on the vendored document view until
 * the Tiptap editor lands; this component exists so AST documents no longer
 * render as raw JSON in the Space panel.
 */
export function AlterDocumentView({ node }: { node: SpaceNode }) {
  const { service } = useSpaceContext();
  const client = documentClientOf(service);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [title, setTitle] = useState(node.title);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (client === undefined) {
      setState({
        kind: 'error',
        message: '文档模型客户端未装配：请刷新页面或重新安装插件',
      });
      return () => {
        alive = false;
      };
    }
    setState({ kind: 'loading' });
    void client
      .get(node.id)
      .then((value) => {
        if (!alive) return;
        setState({ kind: 'ready', snapshot: value as DocumentSnapshot });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      alive = false;
    };
  }, [service, node.id, node.updatedAt]);

  return (
    <article className={styles.page} data-doc-format="alter-doc/1">
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <input
            className={styles.titleInput}
            value={title}
            aria-label="文档标题"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              const next = title.trim();
              if (next === '' || next === node.title) {
                setTitle(node.title);
                return;
              }
              void service
                .saveNode(node.id, { title: next })
                .then(() => undefined)
                .catch(() => setTitle(node.title));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span className={styles.badge}>结构化文档</span>
          <button
            type="button"
            className={panelOpen ? styles.panelToggleActive : styles.panelToggle}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
          >
            评论与历史
          </button>
        </div>
        <div className={styles.meta}>
          {state.kind === 'ready'
            ? `revision ${state.snapshot.revision}`
            : state.kind === 'error'
              ? '加载失败'
              : '正在加载…'}
          <span className={styles.metaDivider}>·</span>
          评论与版本历史将在后续接入
        </div>
      </header>
      <div className={styles.bodyRow}>
        <div className={styles.body}>
        {state.kind === 'loading' ? (
          <div className={styles.state}>正在读取结构化文档…</div>
        ) : state.kind === 'error' ? (
          <div className={styles.error} role="alert">
            无法加载文档：{state.message}
          </div>
        ) : client === undefined ? (
          <div className={styles.error} role="alert">
            文档模型客户端未装配：请刷新页面或重新安装插件
          </div>
        ) : (
          <AlterTiptapEditor
            key={state.snapshot.revision}
            docId={node.id}
            initialDoc={state.snapshot.doc}
            baseRevision={state.snapshot.revision}
            client={client}
            onSaved={(revision, doc) =>
              setState({ kind: 'ready', snapshot: { ...state.snapshot, revision, doc } })
            }
          />
        )}
        </div>
        {panelOpen && state.kind === 'ready' && client !== undefined ? (
          <DocumentSidePanel
            docId={node.id}
            revision={state.snapshot.revision}
            service={service}
            client={client}
            onRestored={(revision) => {
              const nextClient = documentClientOf(service);
              if (nextClient === undefined) return;
              void nextClient
                .get(node.id)
                .then((value) => {
                  const snapshot = value as DocumentSnapshot;
                  setState({ kind: 'ready', snapshot });
                  setTitle(snapshot.title);
                })
                .catch(() => undefined);
              setState((current) =>
                current.kind === 'ready'
                  ? { kind: 'ready', snapshot: { ...current.snapshot, revision } }
                  : current,
              );
            }}
          />
        ) : null}
      </div>
    </article>
  );
}
