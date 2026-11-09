import type { Context } from '@deepseek-ai/cordis';
import type {} from '@alter/client-modules';
import { createElement } from 'react';
import { Settings } from 'lucide-react';
import { SettingsPage, type SettingsCapabilities } from './SettingsPage';

export type { SettingsCapabilities } from './SettingsPage';

export function createSettingsPlugin(capabilities: SettingsCapabilities) {
  function settingsModule(ctx: Context) {
    function SettingsRoute() {
      return createElement(SettingsPage, capabilities);
    }
    ctx.alterModules.register(ctx, {
      id: 'settings',
      label: '设置',
      order: 10,
      placement: 'secondary',
      icon: createElement(Settings, { size: 20, strokeWidth: 1.6 }),
      component: SettingsRoute,
    });
  }
  settingsModule.inject = ['alterModules'];
  return settingsModule;
}
