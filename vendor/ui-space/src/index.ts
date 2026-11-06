import type { Context } from '@deepseek-ai/cordis';
import type {} from '@alter/client-modules';
import { createElement } from 'react';
import { Orbit } from 'lucide-react';
import { SpaceApp } from './SpaceApp';
import type { SpaceCapabilities } from './types';

export type { SpaceCapabilities, SpaceRouter } from './types';

export function createSpacePlugin(capabilities: SpaceCapabilities) {
  function spaceModule(ctx: Context) {
    function SpacePage() {
      return createElement(SpaceApp, capabilities);
    }
    ctx.alterModules.register(ctx, {
      id: 'space',
      label: '空间',
      order: 0,
      icon: createElement(Orbit, { size: 20, strokeWidth: 1.6 }),
      component: SpacePage,
    });
  }
  spaceModule.inject = ['alterModules'];
  return spaceModule;
}

export { WorkbenchChatPage } from './WorkbenchChatPage';

export {
  SpaceHubRegistry,
  createSpaceHubRegistry,
  type SpaceHubPlugin,
} from './hub/registry';
