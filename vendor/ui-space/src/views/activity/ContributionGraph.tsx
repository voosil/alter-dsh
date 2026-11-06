import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SpaceActivityEvent } from '@alter/protocol';
import type { ActivityCalendar, ActivityCell, ActivityRange } from './calendar';
import {
  dayLabel,
  formatRange,
  level,
  summarize,
  weekdayLabel,
} from './calendar';
import styles from './Activity.module.css';

interface ActivityTip {
  cell: ActivityCell;
  left: number;
  top: number;
  below: boolean;
}

function itemText(event: SpaceActivityEvent) {
  return event.kind === 'agent' ? `Alter ${event.title}` : event.title;
}

const CELL = 13;
const GAP = 3;
const STEP = CELL + GAP;
const WEEKDAYS = ['一', '', '三', '', '五', '', ''];

function isInRange(range: ActivityRange | null, key: string) {
  return !!range && key >= range.start && key <= range.end;
}

export function ContributionGraph({
  calendar,
  todayKey,
  range,
  onSelect,
}: {
  calendar: ActivityCalendar;
  todayKey: string;
  range: ActivityRange | null;
  onSelect: (key: string, shiftKey: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLDivElement | null>());
  const [focusKey, setFocusKey] = useState(todayKey);
  const [tip, setTip] = useState<ActivityTip | null>(null);
  const { total, activeDays } = summarize(calendar.cells);
  const columns = calendar.weeks.length;
  const width = Math.max(0, columns * STEP - GAP);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let atEnd = true;
    const scrollToEnd = () => {
      node.scrollLeft = node.scrollWidth;
    };
    const onScroll = () => {
      atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
    };
    const observer = new ResizeObserver(() => {
      if (atEnd) scrollToEnd();
    });
    scrollToEnd();
    onScroll();
    node.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(node);
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  const todayCell = calendar.cells.find((cell) => cell.key === todayKey);

  function showTip(cell: ActivityCell, element: HTMLElement) {
    if (cell.future) return;
    const rect = element.getBoundingClientRect();
    const tipWidth = Math.min(280, window.innerWidth - 24);
    const half = tipWidth / 2;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, half + 12),
      window.innerWidth - half - 12,
    );
    const below = rect.top < (window.innerWidth < 700 ? 340 : 260);
    setTip({
      cell,
      left,
      top: below ? rect.bottom + 8 : rect.top - 8,
      below,
    });
  }

  function focus(rowIndex: number, weekIndex: number) {
    const week = calendar.weeks[Math.min(columns - 1, Math.max(0, weekIndex))];
    const cell = week?.days[Math.min(6, Math.max(0, rowIndex))];
    if (!cell) return;
    const target = cell.future ? todayCell : cell;
    if (!target) return;
    setFocusKey(target.key);
    cells.current.get(target.key)?.focus();
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    cell: ActivityCell,
    weekIndex: number,
    rowIndex: number,
  ) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(cell.key, event.shiftKey);
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
        focus(rowIndex, weekIndex - 1);
        break;
      case 'ArrowRight':
        focus(rowIndex, weekIndex + 1);
        break;
      case 'ArrowUp':
        focus(rowIndex - 1, weekIndex);
        break;
      case 'ArrowDown':
        focus(rowIndex + 1, weekIndex);
        break;
      case 'Home':
        focus(rowIndex, 0);
        break;
      case 'End':
        focus(rowIndex, columns - 1);
        break;
      case 'PageUp':
        focus(0, weekIndex);
        break;
      case 'PageDown':
        focus(6, weekIndex);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const readout = range ? formatRange(range) : `${activeDays} 天有记录`;

  return (
    <div className={styles.graph}>
      <div className={styles.chart}>
        <div className={styles.weekdayColumn} aria-hidden="true">
          {WEEKDAYS.map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>
        <div className={styles.scroller} ref={scroller}>
          <div className={styles.canvas} style={{ width }}>
            <div className={styles.months} aria-hidden="true">
              {calendar.monthLabels.map((label) => (
                <span key={label.key} style={{ left: label.week * STEP }}>
                  {label.label}
                </span>
              ))}
            </div>
            <div
              role="grid"
              aria-label={`过去一年的活动热力图，共 ${total} 次活动。使用方向键浏览日期，Enter 查看当天活动。`}
              aria-rowcount={7}
              aria-colcount={columns}
              className={styles.grid}
              style={{ gridTemplateColumns: `repeat(${columns}, ${CELL}px)` }}
              onMouseLeave={() => setTip(null)}
            >
              {Array.from({ length: 7 }, (_, rowIndex) => (
                <div role="row" className={styles.row} key={rowIndex}>
                  {calendar.weeks.map((week, weekIndex) => {
                    const cell = week.days[rowIndex];
                    if (!cell) return null;
                    const selected = isInRange(range, cell.key);
                    return (
                      <div
                        key={cell.key}
                        ref={(node) => {
                          cells.current.set(cell.key, node);
                        }}
                        role="gridcell"
                        tabIndex={cell.future || cell.key !== focusKey ? -1 : 0}
                        aria-label={
                          cell.future
                            ? undefined
                            : `${dayLabel(cell.key)}${cell.key === todayKey ? '，今天' : ''}，${cell.count} 次活动`
                        }
                        aria-selected={cell.future ? undefined : selected}
                        aria-describedby={
                          tip?.cell.key === cell.key
                            ? 'activity-tooltip'
                            : undefined
                        }
                        aria-disabled={cell.future || undefined}
                        data-level={cell.future ? undefined : level(cell.count)}
                        data-today={cell.key === todayKey || undefined}
                        data-selected={selected || undefined}
                        data-future={cell.future || undefined}
                        className={styles.cell}
                        onClick={(event) => {
                          if (cell.future) return;
                          setFocusKey(cell.key);
                          onSelect(cell.key, event.shiftKey);
                        }}
                        onFocus={(event) => {
                          setFocusKey(cell.key);
                          showTip(cell, event.currentTarget);
                        }}
                        onMouseEnter={(event) => {
                          if (!cell.future) showTip(cell, event.currentTarget);
                        }}
                        onKeyDown={(event) =>
                          handleKeyDown(event, cell, weekIndex, rowIndex)
                        }
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className={styles.graphFoot}>
        <p className={styles.readout}>{readout}</p>
        <div className={styles.legend} aria-hidden="true">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((step) => (
            <i key={step} data-level={step} />
          ))}
          <span>多</span>
        </div>
      </div>
      {tip ? (
        <div
          id="activity-tooltip"
          role="tooltip"
          className={styles.tooltip}
          data-placement={tip.below ? 'below' : 'above'}
          style={{ left: tip.left, top: tip.top }}
        >
          <div className={styles.tooltipHead}>
            <strong>{dayLabel(tip.cell.key)}</strong>
            <span>
              {weekdayLabel(tip.cell.key)} · {tip.cell.count} 次活动
            </span>
          </div>
          {tip.cell.events.length ? (
            <>
              <ul>
                {tip.cell.events.slice(0, 5).map((event) => (
                  <li key={event.id}>{itemText(event)}</li>
                ))}
              </ul>
              {tip.cell.events.length > 5 ? (
                <p>还有 {tip.cell.events.length - 5} 条活动</p>
              ) : null}
            </>
          ) : (
            <p>这一天还没有活动记录。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
