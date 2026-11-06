import type { SpaceActivityDay, SpaceActivityEvent } from '@alter/protocol';

const DAY = 86_400_000;
const YEAR_DAYS = 365;

const monthDay = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
});
const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
const yearMonth = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
});
const yearMonthDay = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface ActivityCell {
  key: string;
  date: Date;
  count: number;
  events: SpaceActivityEvent[];
  future: boolean;
}

export interface ActivityWeek {
  key: string;
  days: ActivityCell[];
}

export interface ActivityMonthLabel {
  key: string;
  label: string;
  week: number;
}

export interface ActivityCalendar {
  weeks: ActivityWeek[];
  monthLabels: ActivityMonthLabel[];
  cells: ActivityCell[];
}

export interface ActivityRange {
  start: string;
  end: string;
}

export interface ActivityDayGroup {
  key: string;
  label: string;
  weekday: string;
  events: SpaceActivityEvent[];
}

export interface ActivityMonthGroup {
  key: string;
  label: string;
  days: ActivityDayGroup[];
}

export function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function localDayKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function shiftDayKey(key: string, amount: number): string {
  return localDayKey(addDays(parseDayKey(key), amount));
}

export function daysBetween(start: string, end: string): number {
  return Math.round(
    (parseDayKey(end).getTime() - parseDayKey(start).getTime()) / DAY,
  );
}

function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

/**
 * 最近 53 周的日历，按周一开始，最后一周截到今天。
 * 没有记录的日期保留为空单元格，今天之后的日期标记为 future。
 */
export function buildCalendar(
  activity: SpaceActivityDay[],
  now = new Date(),
): ActivityCalendar {
  const today = startOfDay(now);
  const byDate = new Map(activity.map((day) => [day.date, day]));
  const start = startOfWeek(addDays(today, -(YEAR_DAYS - 1)));
  const weeks: ActivityWeek[] = [];
  for (
    let cursor = start;
    cursor.getTime() <= today.getTime();
    cursor = addDays(cursor, 7)
  ) {
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = addDays(cursor, offset);
      const key = localDayKey(date);
      const day = byDate.get(key);
      return {
        key,
        date,
        count: day?.count ?? 0,
        events: day?.events ?? [],
        future: date.getTime() > today.getTime(),
      };
    });
    weeks.push({ key: localDayKey(cursor), days });
  }

  const monthLabels: ActivityMonthLabel[] = [];
  weeks.forEach((week, index) => {
    const first =
      index === 0
        ? week.days.find((day) => !day.future)
        : week.days.find((day) => day.date.getDate() === 1);
    const month = first?.date.getMonth() ?? week.days[0]?.date.getMonth();
    if (month === undefined) return;
    const previous = monthLabels[monthLabels.length - 1];
    if (previous && index - previous.week < 3) return;
    if (previous && previous.label === `${month + 1}月`) return;
    monthLabels.push({
      key: `${month}-${index}`,
      label: `${month + 1}月`,
      week: index,
    });
  });

  return {
    weeks,
    monthLabels,
    cells: weeks.flatMap((week) => week.days),
  };
}

export function summarize(cells: ActivityCell[]) {
  let total = 0;
  let activeDays = 0;
  for (const cell of cells) {
    if (cell.future || cell.count <= 0) continue;
    total += cell.count;
    activeDays += 1;
  }
  return { total, activeDays };
}

export function level(count: number) {
  return count <= 0 ? 0 : Math.min(4, count);
}

export function dayLabel(key: string, now = new Date()): string {
  const date = parseDayKey(key);
  return date.getFullYear() === now.getFullYear()
    ? monthDay.format(date)
    : yearMonthDay.format(date);
}

export function weekdayLabel(key: string): string {
  return weekday.format(parseDayKey(key));
}

export function monthLabel(key: string): string {
  return yearMonth.format(parseDayKey(key));
}

export function timeLabel(at: string): string {
  return clock.format(new Date(at));
}

export function formatRange(range: ActivityRange, now = new Date()): string {
  if (range.start === range.end) {
    return `${dayLabel(range.start, now)} ${weekdayLabel(range.start)}`;
  }
  return `${dayLabel(range.start, now)} – ${dayLabel(range.end, now)}`;
}

/** 按事件发生时间倒序分组为月 > 日。 */
export function groupEvents(
  events: SpaceActivityEvent[],
  now = new Date(),
): ActivityMonthGroup[] {
  const months: ActivityMonthGroup[] = [];
  for (const event of events) {
    const key = localDayKey(event.at);
    if (!key) continue;
    const monthKey = key.slice(0, 7);
    let month = months[months.length - 1];
    if (month?.key !== monthKey) {
      month = { key: monthKey, label: monthLabel(key), days: [] };
      months.push(month);
    }
    let day = month.days[month.days.length - 1];
    if (day?.key !== key) {
      day = {
        key,
        label: dayLabel(key, now),
        weekday: weekdayLabel(key),
        events: [],
      };
      month.days.push(day);
    }
    day.events.push(event);
  }
  return months;
}
