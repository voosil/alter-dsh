import { useCallback, useState } from 'react';
import { ArrowRight, FileText } from 'lucide-react';
import type { SpaceOverview } from '@alter/protocol';
import { Button } from '@alter/ui-system';
import { ContributionGraph } from './activity/ContributionGraph';
import { ContributionTimeline } from './activity/ContributionTimeline';
import {
  buildCalendar,
  daysBetween,
  localDayKey,
  shiftDayKey,
  summarize,
  type ActivityRange,
} from './activity/calendar';
import activityStyles from './activity/Activity.module.css';
import layout from './OverviewView.module.css';

export function OverviewActivity({
  activity,
  recentDocs,
  agentEvents,
  onOpenDoc,
  onOpenAgentEvent,
}: {
  activity: SpaceOverview['activity'];
  recentDocs: SpaceOverview['recentDocs'];
  agentEvents: SpaceOverview['agentEvents'];
  onOpenDoc: (docId: string) => void;
  onOpenAgentEvent?: (agentEventId: string) => void;
}) {
  const [view, setView] = useState<'activity' | 'recent'>('activity');
  const [range, setRange] = useState<ActivityRange | null>(null);
  const now = new Date();
  const todayKey = localDayKey(now);
  const calendar = buildCalendar(activity, now);
  const { total } = summarize(calendar.cells);

  const events = calendar.cells
    .flatMap((cell) => cell.events)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter((event) => {
      if (!range) return true;
      const key = localDayKey(event.at);
      return key >= range.start && key <= range.end;
    });

  const onSelect = useCallback((key: string, extend: boolean) => {
    setRange((current) => {
      if (!extend || !current) {
        if (current && current.start === key && current.end === key) {
          return null;
        }
        return { start: key, end: key };
      }
      const start = key < current.start ? key : current.start;
      const end = key > current.end ? key : current.end;
      return {
        start: daysBetween(start, end) > 30 ? shiftDayKey(end, -30) : start,
        end,
      };
    });
  }, []);

  return (
    <section className={layout.activity} aria-labelledby="overview-activity">
      <div className={layout.sectionHead}>
        <div className={activityStyles.headLeft}>
          <h2 id="overview-activity">活动</h2>
          {view === 'activity' ? (
            <p className={layout.sectionNote}>
              {total ? `过去一年 ${total} 次活动` : '过去一年还没有活动记录'}
            </p>
          ) : null}
        </div>
        <div
          className={activityStyles.viewTabs}
          role="group"
          aria-label="活动视图"
        >
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === 'activity'}
            onClick={() => setView('activity')}
          >
            活动记录
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === 'recent'}
            onClick={() => setView('recent')}
          >
            文档与活动
          </Button>
        </div>
      </div>
      {view === 'activity' ? (
        <>
          <ContributionGraph
            calendar={calendar}
            todayKey={todayKey}
            range={range}
            onSelect={onSelect}
          />
          <ContributionTimeline
            key={range ? `${range.start}:${range.end}` : 'all'}
            events={events}
            range={range}
            onClearRange={() => setRange(null)}
            onOpenDoc={onOpenDoc}
            onOpenAgentEvent={onOpenAgentEvent}
          />
        </>
      ) : (
        <div className={layout.recentColumns}>
          <div className={layout.recentColumn}>
            <div className={layout.columnHead}>
              <h3>近期文档</h3>
            </div>
            {recentDocs.length ? (
              <ul className={layout.list}>
                {recentDocs.map((doc) => (
                  <li key={doc.id}>
                    <Button
                      variant="ghost"
                      className={layout.row}
                      onClick={() => onOpenDoc(doc.id)}
                    >
                      <FileText
                        size={15}
                        className={layout.rowIcon}
                        aria-hidden="true"
                      />
                      <span className={layout.rowMain}>
                        <strong>{doc.title || '未命名文档'}</strong>
                      </span>
                      <ArrowRight
                        size={15}
                        className={layout.rowArrow}
                        aria-hidden="true"
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={layout.empty}>这个空间还没有文档。</p>
            )}
          </div>
          <div className={layout.recentColumn}>
            <div className={layout.columnHead}>
              <h3>Alter 的活动</h3>
            </div>
            {agentEvents.length ? (
              <ul className={layout.list}>
                {agentEvents.map((event) => (
                  <li key={event.id}>
                    <Button
                      variant="ghost"
                      className={layout.row}
                      onClick={() => onOpenAgentEvent?.(event.id)}
                    >
                      <span className={layout.rowMark} aria-hidden="true" />
                      <span className={layout.rowMain}>
                        <strong>{event.title}</strong>
                      </span>
                      <ArrowRight
                        size={15}
                        className={layout.rowArrow}
                        aria-hidden="true"
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={layout.empty}>Alter 还没有留下活动记录。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
