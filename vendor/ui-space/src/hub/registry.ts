import type { ComponentType } from 'react';
import { OverviewView } from '../views/OverviewView';
import { ConfigView } from '../views/ConfigView';
export interface SpaceHubPlugin {
  id: string;
  component: ComponentType;
}
/** Owned by the Space assembly. Registration returns a lifecycle cleanup. */
export class SpaceHubRegistry {
  private entries = new Map<string, SpaceHubPlugin>();
  private snapshot: readonly SpaceHubPlugin[] = [];
  private listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  register(plugin: SpaceHubPlugin) {
    if (!/^[a-z][a-z0-9-]*$/.test(plugin.id) || this.entries.has(plugin.id))
      throw new Error('Invalid or duplicate Space plugin');
    this.entries.set(plugin.id, plugin);
    this.publish();
    return () => {
      if (this.entries.get(plugin.id) === plugin) {
        this.entries.delete(plugin.id);
        this.publish();
      }
    };
  }
  private publish() {
    this.snapshot = [...this.entries.values()];
    for (const listener of this.listeners) listener();
  }
}
export function createSpaceHubRegistry() {
  const registry = new SpaceHubRegistry();
  // 当前实现批次只提供「概览」「配置」；其余详情插件随依赖暂缓恢复。
  for (const plugin of [
    { id: 'overview', component: OverviewView },
    { id: 'config', component: ConfigView },
  ])
    registry.register(plugin);
  return registry;
}
