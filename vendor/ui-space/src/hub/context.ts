import { createContext, useContext, useState } from 'react';
import type { HubSnapshot } from '@alter/protocol';

import { useSpaceContext } from '../runtime';

export const HubContext = createContext<HubSnapshot | null>(null);
export function useHub() {
  const value = useContext(HubContext);
  if (!value) throw new Error('Space hub is unavailable');
  return value;
}
export function useHubAction() {
  const { refresh } = useSpaceContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await action();
      refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未成功，请重试');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
export const statusLabels = {
  planning: '新计划',
  waiting: '等你回应',
  running: '正在做',
  completed: '已完成',
  abandoned: '已废弃',
} as const;
export function dateText(at: string) {
  return at
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
      }).format(new Date(at))
    : '接下来';
}
export function hubPath(spaceId: string, pluginId: string) {
  return ['overview', 'config'].includes(pluginId)
    ? `#/space/${spaceId}/${pluginId}`
    : `#/space/${spaceId}/plugin/${pluginId}`;
}
