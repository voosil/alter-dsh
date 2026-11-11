/**
 * The overview activity feed answers "what happened in this space that is worth
 * remembering", not "what changed in the database" (record policy in
 * `vendor/README.md`). These server-rendered checks keep the empty-state
 * explanation and the milestone entry shapes from drifting back into a raw
 * edit log.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpaceActivityEvent } from '../../../vendor/protocol/src/index';
import { ContributionTimeline } from '../../../vendor/ui-space/src/views/activity/ContributionTimeline';

const entries: SpaceActivityEvent[] = [
  {
    id: 'act-space-s1',
    at: '2026-11-01T10:00:00.000Z',
    kind: 'space',
    title: '创建了空间「研究」',
  },
  {
    id: 'act-doc-create-d1',
    at: '2026-11-01T09:00:00.000Z',
    kind: 'doc',
    title: '新建《访谈整理》',
    label: '新建',
    docId: 'd1',
    docTitle: '访谈整理',
  },
  {
    id: 'act-doc-archive-d2',
    at: '2026-11-02T09:00:00.000Z',
    kind: 'doc',
    title: '归档《访谈整理》',
    label: '归档',
    docId: 'd1',
    docTitle: '访谈整理',
  },
];

const noop = () => {};

function render(events: SpaceActivityEvent[], range = null) {
  return renderToStaticMarkup(
    createElement(ContributionTimeline, {
      events,
      range,
      onClearRange: noop,
      onOpenDoc: noop,
    }),
  );
}

describe('overview activity timeline', () => {
  it('explains that only noteworthy changes are recorded when the feed is empty', () => {
    const html = render([]);
    expect(html).toContain('还没有值得记录的事');
    expect(html).toContain('版本历史');
  });

  it('renders the space and document milestones produced by the Host', () => {
    const html = render(entries);
    expect(html).toContain('创建了空间「研究」');
    expect(html).toContain('新建');
    expect(html).toContain('归档');
    expect(html).toContain('访谈整理');
    expect(html).toContain('3 次');
  });
});
