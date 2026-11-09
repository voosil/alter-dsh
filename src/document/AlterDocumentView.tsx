import { useEffect, useState } from 'react';
import type { SpaceNode } from '@alter/protocol';
import { useSpaceContext } from '../../vendor/ui-space/src/runtime';
import { documentClientOf } from './client-access';
import { DocumentContent } from './DocumentContent';
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
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    const client = documentClientOf(service);
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
          <h1 className={styles.title}>{node.title || '未命名文档'}</h1>
          <span className={styles.badge}>结构化文档 · 只读预览</span>
        </div>
        <div className={styles.meta}>
          {state.kind === 'ready'
            ? `revision ${state.snapshot.revision}`
            : state.kind === 'error'
              ? '加载失败'
              : '正在加载…'}
          <span className={styles.metaDivider}>·</span>
          编辑、评论与版本历史将在编辑器接入后启用
        </div>
      </header>
      <div className={styles.body}>
        {state.kind === 'loading' ? (
          <div className={styles.state}>正在读取结构化文档…</div>
        ) : state.kind === 'error' ? (
          <div className={styles.error} role="alert">
            无法加载文档：{state.message}
          </div>
        ) : (
          <DocumentContent doc={state.snapshot.doc} />
        )}
      </div>
    </article>
  );
}
