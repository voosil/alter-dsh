import { useHubNavigation } from './navigation';
import { useState } from 'react';
import {
  ArrowUpRight,
  Search,
  Plus,
  Circle,
  CircleHelp,
  Loader,
  CheckCircle2,
  CircleSlash,
} from 'lucide-react';
import type { MatterStatus } from '@alter/protocol';
import { Button, Dialog, Field, Input, Textarea } from '@alter/ui-system';
import { SpaceDetailShell } from '../views/SpaceDetailShell';
import { useSpaceContext } from '../runtime';
import { useHub, useHubAction, statusLabels, dateText } from './context';
import styles from './Hub.module.css';

export function ActivityView() {
  const hub = useHub();
  const { service, spaceId } = useSpaceContext();
  const { openMatter } = useHubNavigation();
  const action = useHubAction();
  const [filter, setFilter] = useState<MatterStatus>('waiting');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const statusIcons = {
    planning: Circle,
    waiting: CircleHelp,
    running: Loader,
    completed: CheckCircle2,
    abandoned: CircleSlash,
  };
  const StatusIcon = statusIcons[filter];
  const items = hub.matters.filter(
    (item) =>
      item.status === filter &&
      `${item.title} ${item.description}`.includes(search.trim()),
  );
  return (
    <SpaceDetailShell
      active="activity"
      description="让计划、判断与行动都有迹可循。"
    >
      <div className={styles.actions}>
        <span className={styles.note}>{hub.matters.length} 件事项</span>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" />
          添加事项
        </Button>
      </div>
      <div className={styles.statusTabs} role="group" aria-label="事项状态">
        {Object.entries(statusLabels).map(([status, label]) => (
          <Button
            key={status}
            variant="ghost"
            aria-pressed={filter === status}
            onClick={() => setFilter(status as MatterStatus)}
          >
            {label}
            <span className={styles.number}>
              {hub.matters.filter((item) => item.status === status).length}
            </span>
          </Button>
        ))}
      </div>
      <div className={styles.searchField}>
        <Search size={16} aria-hidden="true" />
        <Input
          aria-label="搜索事项"
          placeholder="搜索当前状态下的事项"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className={styles.list}>
        {items.length ? (
          items.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              className={styles.matterRow}
              data-status={item.status}
              onClick={() => void openMatter(item.id)}
            >
              <StatusIcon
                size={19}
                strokeWidth={1.5}
                className={styles.matterIcon}
                aria-hidden="true"
              />
              <span className={styles.rowMain}>
                <strong>
                  {item.title}
                  {item.unread ? (
                    <span className={styles.unread} aria-label="新动态" />
                  ) : null}
                </strong>
                <span>{item.description}</span>
                <small>
                  {item.agent} · {item.type} · {dateText(item.createdAt)}发起
                </small>
              </span>
              <span className={styles.rowEnd}>
                {dateText(item.updatedAt)}
                <ArrowUpRight size={16} aria-hidden="true" />
              </span>
            </Button>
          ))
        ) : (
          <div className={styles.empty}>
            <h2>
              {search ? '没有匹配的事项' : `暂无${statusLabels[filter]}的事项`}
            </h2>
            <p>
              {search
                ? '换一个关键词，或切换状态。'
                : '有新的进展时，会出现在这里。也可以主动添加一件想做的事。'}
            </p>
          </div>
        )}
      </div>
      <Dialog
        open={creating}
        onClose={() => {
          if (!action.busy) setCreating(false);
        }}
        title="添加事项"
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={action.busy}>
              取消
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="new-matter"
              disabled={action.busy || !title.trim()}
            >
              加入新计划
            </Button>
          </>
        }
      >
        <form
          id="new-matter"
          className={styles.form}
          onSubmit={async (event) => {
            event.preventDefault();
            const ok = await action.run(() =>
              service.hub.createMatter(spaceId, title, description),
            );
            if (ok) {
              setCreating(false);
              setTitle('');
              setDescription('');
              setFilter('planning');
            }
          }}
        >
          <Field label="事项标题" htmlFor="matter-title">
            <Input
              id="matter-title"
              value={title}
              autoFocus
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="描述" htmlFor="matter-description">
            <Textarea
              id="matter-description"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="想做什么，为什么现在想做？"
            />
          </Field>
          {action.error ? <p role="alert">{action.error}</p> : null}
        </form>
      </Dialog>
    </SpaceDetailShell>
  );
}
