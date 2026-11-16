/**
 * 时间格式化（侧边对话历史与引用预览卡共用）。
 *
 * 浏览器的本地时区：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 / 更早 MM-DD；无法解析
 * 的时间渲染为空串，调用方据此决定是否显示时间。
 */

/**
 * Relative time of a record, in the browser's local time: 刚刚, N 分钟前,
 * today's HH:mm, 昨天, else MM-DD. Unparseable timestamps render empty.
 */
export function formatRelativeTime(updatedAt: string, now: number): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return '';
  const difference = now - then;
  if (difference < 60_000) return '刚刚';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  const thenDate = new Date(then);
  const nowDate = new Date(now);
  if (sameLocalDate(thenDate, nowDate)) return localClock(thenDate);
  const yesterday = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDate(thenDate, yesterday)) return '昨天';
  return `${pad2(thenDate.getMonth() + 1)}-${pad2(thenDate.getDate())}`;
}

function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function localClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
  return value >= 10 ? String(value) : `0${value}`;
}

