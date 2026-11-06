import { useEffect, useRef, useState } from 'react';
import type { SpaceOverview } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { SpaceDetailShell } from './SpaceDetailShell';
import { OverviewActivity } from './OverviewActivity';
import { SpaceSummary, SpaceUsage } from './OverviewInsights';
import { useHub } from '../hub/context';
import { docPath } from '../space-route';
import { displayTitle } from '../utils/tree';
import styles from './OverviewView.module.css';

function longDate(at: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(
    new Date(at),
  );
}

export function OverviewView() {
  const {
    space,
    spaceId,
    nodes,
    agents,
    service,
    router,
    version,
    workbench,
    toast,
  } = useSpaceContext();
  const hub = useHub();
  const [overview, setOverview] = useState<SpaceOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const introduced = useRef(false);

  useEffect(() => {
    if (
      introduced.current ||
      hub.onboarding !== 'pending' ||
      !workbench ||
      space.isDefault
    )
      return;
    introduced.current = true;
    workbench.controller.launch(workbench.scopeKey, 'chat', {
      chatPurpose: 'introduction',
      title: '聊聊这个空间',
    });
  }, [hub.onboarding, workbench, space.isDefault]);

  useEffect(() => {
    let alive = true;
    service
      .getOverview(spaceId)
      .then((data) => {
        if (!alive) return;
        setOverview(data);
        setFailed(false);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [service, spaceId, version]);

  function openDoc(docId: string) {
    const node = nodes.find(
      (item) => item.id === docId && item.kind === 'note' && !item.deletedAt,
    );
    if (workbench && node) {
      workbench.controller.launch(workbench.scopeKey, 'document', {
        documentId: docId,
        title: displayTitle(node.title),
      });
      return;
    }
    router.navigate(docPath(spaceId, docId));
  }

  function openAgentEvent(agentEventId: string) {
    const event = overview?.agentEvents.find(
      (item) => item.id === agentEventId,
    );
    if (!event) return;
    if (!workbench) {
      toast('Workbench 暂不可用');
      return;
    }
    workbench.controller.launch(workbench.scopeKey, 'resource', {
      resourceType: 'event',
      resourceId: event.id,
      title: event.title,
      draft: JSON.stringify(event),
    });
  }

  const collaborators = space.collaboratorIds
    .map((id) => agents.find((agent) => agent.id === id)?.name)
    .filter(Boolean);

  return (
    <SpaceDetailShell active="overview" description={space.goal || undefined}>
      <div className={styles.meta} aria-label="空间信息">
        <span>创建于 {longDate(space.createdAt)}</span>
        <span>协作者 {collaborators.join('、') || 'Alter'}</span>
        <span>工作目录 {space.directories.length} 个</span>
      </div>
      {failed && !overview ? (
        <p role="alert" className={styles.error}>
          空间概览暂时无法读取，请刷新后重试。
        </p>
      ) : null}
      {!overview && !failed ? (
        <p role="status" className={styles.loading}>
          正在读取空间概览…
        </p>
      ) : null}
      {overview ? (
        <div className={styles.modules}>
          <SpaceSummary />
          <OverviewActivity
            activity={overview.activity}
            recentDocs={overview.recentDocs}
            agentEvents={overview.agentEvents}
            onOpenDoc={openDoc}
            onOpenAgentEvent={openAgentEvent}
          />
          <SpaceUsage />
        </div>
      ) : null}
    </SpaceDetailShell>
  );
}
