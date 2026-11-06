import { useEffect, useState } from 'react';
import { Brush, ChevronRight, FileText, RotateCcw, Trash2 } from 'lucide-react';
import type { SpaceNode, Thought } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { overviewPath } from '../space-route';
import { formatShortDate, formatThoughtLabel } from '../utils/date';
import { ancestorsOf, displayTitle } from '../utils/tree';
import { DirectoryButton } from '../components/DirectoryButton';
import { Button, Dialog, IconButton } from '@alter/ui-system';
import styles from './CollectionView.module.css';

function emptySummary(deleted: { nodes: SpaceNode[]; thoughts: Thought[] }) {
  const parts: string[] = [];
  if (deleted.nodes.length) parts.push(`${deleted.nodes.length} 篇文档`);
  if (deleted.thoughts.length) parts.push(`${deleted.thoughts.length} 条随想`);
  return `回收站里的 ${parts.join('和 ')}`;
}

export function TrashView() {
  const { service, router, space, spaceId, nodes, version, refresh, toast } =
    useSpaceContext();
  const [deleted, setDeleted] = useState<{
    nodes: SpaceNode[];
    thoughts: Thought[];
  }>({ nodes: [], thoughts: [] });
  const [preview, setPreview] = useState<Thought | null>(null);
  const [tab, setTab] = useState<'docs' | 'thoughts'>('docs');
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);

  useEffect(() => {
    let alive = true;
    void service.listDeleted(spaceId).then((result) => {
      if (alive) setDeleted(result);
    });
    return () => {
      alive = false;
    };
  }, [service, spaceId, version]);

  function originalPath(node: SpaceNode) {
    if (!node.originalParentId) return [space.name];
    const parent = nodes.find((item) => item.id === node.originalParentId);
    if (!parent) return [space.name];
    return [
      space.name,
      ...ancestorsOf(nodes, parent.id).map((item) => displayTitle(item.title)),
      displayTitle(parent.title),
    ];
  }

  async function restoreNode(node: SpaceNode) {
    await service.restoreNode(node.id);
    setDeleted((current) => ({
      ...current,
      nodes: current.nodes.filter((item) => item.id !== node.id),
    }));
    refresh();
    toast('已还原');
  }

  async function emptyTrash() {
    setEmptying(true);
    try {
      await service.emptyTrash(spaceId);
      setDeleted({ nodes: [], thoughts: [] });
      setEmptyOpen(false);
      refresh();
      toast('回收站已清空');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '清空失败，请重试');
    } finally {
      setEmptying(false);
    }
  }

  async function restoreThought(thought: Thought) {
    await service.restoreThought(thought.id);
    setDeleted((current) => ({
      ...current,
      thoughts: current.thoughts.filter((item) => item.id !== thought.id),
    }));
    setPreview(null);
    refresh();
    toast('已还原');
  }

  return (
    <section className={styles.page} aria-labelledby="trash-page-title">
      <header className={styles.toolbar}>
        <DirectoryButton />
        <nav className={styles.crumbs} aria-label="目录层级">
          <button
            type="button"
            className={styles.crumb}
            onClick={() => router.navigate(overviewPath(spaceId))}
          >
            {space.name}
          </button>
          <ChevronRight
            size={10}
            strokeWidth={1.8}
            className={styles.crumbChevron}
            aria-hidden="true"
          />
          <span className={styles.currentCrumb}>回收站</span>
        </nav>
      </header>

      <div className={styles.scroll}>
        <div className={styles.body}>
          <header className={styles.hero}>
            <h1 id="trash-page-title" className={styles.pageTitle}>
              回收站
            </h1>
          </header>
          <div className={styles.tabsRow}>
            <div className={styles.tabs} role="tablist" aria-label="回收站内容">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'docs'}
                className={styles.tab}
                onClick={() => setTab('docs')}
              >
                文档
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'thoughts'}
                className={styles.tab}
                onClick={() => setTab('thoughts')}
              >
                随想
              </button>
            </div>
            {deleted.nodes.length || deleted.thoughts.length ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => setEmptyOpen(true)}
              >
                <Trash2 size={12} strokeWidth={1.7} aria-hidden="true" />
                清空回收站
              </button>
            ) : null}
          </div>

          {tab === 'docs' ? (
            deleted.nodes.length ? (
              <div className={styles.list}>
                {deleted.nodes.map((node) => {
                  const origin = originalPath(node);
                  return (
                    <div key={node.id} className={styles.row}>
                      <span className={styles.rowIcon} aria-hidden="true">
                        <FileText size={15} strokeWidth={1.5} />
                      </span>
                      <div
                        className={styles.rowMain}
                        data-static=""
                        role="group"
                      >
                        <span className={styles.title}>
                          {displayTitle(node.title)}
                        </span>
                        <span className={styles.meta}>
                          <span
                            className={styles.origin}
                            aria-label={`原位置：${origin.join(' / ')}`}
                          >
                            {origin.map((part, index) => (
                              <span key={index} className={styles.originPart}>
                                {index > 0 ? (
                                  <ChevronRight
                                    size={9}
                                    strokeWidth={1.8}
                                    className={styles.originChevron}
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {part}
                              </span>
                            ))}
                          </span>
                          {node.deletedAt ? (
                            <span className={styles.metaSuffix}>
                              · {formatShortDate(node.deletedAt)} 删除
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <IconButton
                        label="还原"
                        size="sm"
                        tooltipPlacement="top"
                        icon={<RotateCcw />}
                        onClick={() => void restoreNode(node)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={styles.emptyNote}>回收站里没有文档。</p>
            )
          ) : deleted.thoughts.length ? (
            <div className={styles.list}>
              {deleted.thoughts.map((thought) => (
                <div key={thought.id} className={styles.row}>
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Brush size={15} strokeWidth={1.5} />
                  </span>
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => setPreview(thought)}
                  >
                    <span className={styles.title}>
                      {formatThoughtLabel(thought.createdAt)}
                    </span>
                    <span className={styles.meta}>
                      {thought.deletedAt
                        ? `${formatShortDate(thought.deletedAt)} 删除`
                        : ''}
                    </span>
                  </button>
                  <IconButton
                    label="还原"
                    size="sm"
                    tooltipPlacement="top"
                    icon={<RotateCcw />}
                    onClick={() => void restoreThought(thought)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.emptyNote}>回收站里没有随想。</p>
          )}
        </div>
      </div>

      <Dialog
        open={emptyOpen}
        onClose={() => setEmptyOpen(false)}
        title="清空回收站？"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEmptyOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={emptying}
              onClick={() => void emptyTrash()}
            >
              {emptying ? '正在清空…' : '清空回收站'}
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>
          {emptySummary(deleted)}将永久删除，无法恢复。
        </p>
      </Dialog>

      <Dialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview ? formatThoughtLabel(preview.createdAt) : '随想'}
        size="medium"
        footer={
          <>
            <button
              type="button"
              className={styles.action}
              onClick={() => setPreview(null)}
            >
              关闭
            </button>
            {preview ? (
              <Button
                variant="primary"
                size="sm"
                className={styles.dialogRestoreAction}
                onClick={() => void restoreThought(preview)}
              >
                <RotateCcw size={11} strokeWidth={1.7} aria-hidden="true" />
                还原
              </Button>
            ) : null}
          </>
        }
      >
        {preview ? (
          <>
            <p className={styles.previewMeta}>
              删除于{' '}
              {preview.deletedAt ? formatShortDate(preview.deletedAt) : '刚刚'}
            </p>
            <div
              className={styles.previewContent}
              dangerouslySetInnerHTML={{ __html: preview.content }}
            />
          </>
        ) : null}
      </Dialog>
    </section>
  );
}
