function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatDayLabel(value: string, now = new Date()) {
  const date = new Date(value);
  const today = startOfDay(now);
  const target = startOfDay(date);
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 1 && diff < 7)
    return new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date);
  if (date.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
    }).format(date);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatRelativeTime(value: string, now = new Date()) {
  const date = new Date(value);
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (isSameDay(date, now)) return `今天 ${formatTime(value)}`;
  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (dayDiff === 1) return `昨天 ${formatTime(value)}`;
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} 天前`;
  if (date.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
    }).format(date);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatFullDate(value: string) {
  return formatDateTime(value);
}

export function formatShortDate(value: string) {
  return formatDateTime(value);
}

export function formatThoughtLabel(value: string) {
  return `随想 ${formatDateTime(value)}`;
}

export function groupByDay<T>(
  items: T[],
  getDate: (item: T) => string,
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = formatDayLabel(getDate(item));
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
