import { Context, Service } from '@deepseek-ai/cordis';
import type { ComponentType, ReactNode } from 'react';

export interface ClientModule {
  id: string;
  label: string;
  icon?: ReactNode;
  order?: number;
  placement?: 'primary' | 'secondary';
  component: ComponentType;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    alterModules: ModuleRegistry;
  }
}

/** The sole public UI extension: a navigation entry and its module page. */
export class ModuleRegistry extends Service {
  private entries = new Map<string, Readonly<ClientModule>>();
  private listeners = new Set<() => void>();
  private snapshot: readonly Readonly<ClientModule>[] = [];

  constructor(ctx: Context) {
    super(ctx, 'alterModules');
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  register(owner: Context, module: ClientModule) {
    if (!/^[a-z][a-z0-9-]*$/.test(module.id) || !module.label.trim()) {
      throw new Error('Invalid module identity');
    }
    if (this.entries.has(module.id))
      throw new Error(`Duplicate module: ${module.id}`);
    return owner.effect(() => {
      this.entries.set(module.id, Object.freeze({ ...module }));
      this.publish();
      return () => {
        this.entries.delete(module.id);
        this.publish();
      };
    });
  }

  private publish() {
    this.snapshot = Object.freeze(
      [...this.entries.values()].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
      ),
    );
    for (const listener of this.listeners) listener();
  }
}
