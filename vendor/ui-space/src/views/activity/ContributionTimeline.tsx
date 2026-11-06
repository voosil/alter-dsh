import { useState } from 'react';
import {
  ArrowUpRight,
  FileText,
  FolderPlus,
  ListChecks,
  MessageSquare,
  PenLine,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { SpaceActivityEvent, SpaceActivityKind } from '@alter/protocol';
import { Button } from '@alter/ui-system';
import {
  formatRange,
  groupEvents,
  localDayKey,
  timeLabel,
  type ActivityRange,
} from './calendar';
import styles from './Activity.module.css';

const INITIAL_DAYS = 3;
const MORE_DAYS = 10;

function takeDays(events: SpaceActivityEvent[], days: number) {
  const seen = new Set<string>();
  const result: SpaceActivityEvent[] = [];
  for (const event of events) {
    const key = localDayKey(event.at);
    if (!seen.has(key)) {
      if (seen.size >= days) break;
      seen.add(key);
    }
    result.push(event);
  }
  return result;
}

const ICONS: Record<SpaceActivityKind, LucideIcon> = {
  space: FolderPlus,
  doc: FileText,
  thought: PenLine,
  comment: MessageSquare,
  task: ListChecks,
  agent: Sparkles,
};

function Entry({
  event,
  onOpenDoc,
  onOpenAgentEvent,
}: {
  event: SpaceActivityEvent;
  onOpenDoc: (docId: string) => void;
  onOpenAgentEvent?: (agentEventId: string) => void;
}) {
  const Icon = ICONS[event.kind];
  const label = event.label ?? event.title;
  const agentEventId =
    event.agentEventId && onOpenAgentEvent ? event.agentEventId : null;
  const docId = event.docId && event.docTitle ? event.docId : null;
  const separator =
    docId && event.kind !== 'doc' && event.kind !== 'comment' ? ' · ' : null;

  return (
    <div className={styles.entry} title={event.detail}>
      <Icon size={14} className={styles.entryIcon} aria-hidden="true" />
      {agentEventId ? (
        <button
          type="button"
          className={styles.agentLink}
          onClick={() => onOpenAgentEvent?.(agentEventId)}
        >
          <Sparkles size={12} aria-hidden="true" />
          <span>{event.title}</span>
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      ) : docId ? (
        <span className={styles.entryText}>
          {label}
          {separator}
          <button
            type="button"
            className={styles.docLink}
            aria-label={`打开《${event.docTitle}》`}
            onClick={() => onOpenDoc(docId)}
          >
            <FileText size={12} aria-hidden="true" />《{event.docTitle}》
          </button>
        </span>
      ) : (
        <span className={styles.entryText}>{label}</span>
      )}
      <time className={styles.entryTime} dateTime={event.at}>
        {timeLabel(event.at)}
      </time>
    </div>
  );
}

export function ContributionTimeline({
  events,
  range,
  onClearRange,
  onOpenDoc,
  onOpenAgentEvent,
}: {
  events: SpaceActivityEvent[];
  range: ActivityRange | null;
  onClearRange: () => void;
  onOpenDoc: (docId: string) => void;
  onOpenAgentEvent?: (agentEventId: string) => void;
}) {
  const [days, setDays] = useState(INITIAL_DAYS);
  const visible = takeDays(events, days);
  const months = groupEvents(visible);

  return (
    <section className={styles.timeline} aria-labelledby="activity-log">
      <div className={styles.timelineHead}>
        <h3 id="activity-log">活动记录</h3>
        <div className={styles.timelineMeta}>
          <span aria-live="polite">
            {range ? formatRange(range) : '最近的活动'} · {events.length} 次
          </span>
          {range ? (
            <Button
              size="sm"
              variant="ghost"
              className={styles.clear}
              onClick={onClearRange}
            >
              查看全部
            </Button>
          ) : null}
        </div>
      </div>
      {events.length ? (
        <>
          {months.map((month) => (
            <section className={styles.month} key={month.key}>
              <h4 className={styles.monthLabel}>{month.label}</h4>
              {month.days.map((day) => (
                <div className={styles.dayGroup} key={day.key}>
                  <div className={styles.dayLabel}>
                    <time dateTime={day.key}>{day.label}</time>
                    <span>{day.weekday}</span>
                  </div>
                  <ul className={styles.entries}>
                    {day.events.map((event) => (
                      <li key={event.id}>
                        <Entry
                          event={event}
                          onOpenDoc={onOpenDoc}
                          onOpenAgentEvent={onOpenAgentEvent}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
          {visible.length < events.length ? (
            <div className={styles.more}>
              <Button
                size="sm"
                variant="ghost"
                className={styles.moreButton}
                onClick={() => setDays((value) => value + MORE_DAYS)}
              >
                显示更多活动
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.empty}>
          {range ? '这段时间还没有活动记录。' : '这个空间还没有活动记录。'}
        </p>
      )}
    </section>
  );
}
