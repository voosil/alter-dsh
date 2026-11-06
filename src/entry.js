/**
 * The Space feature as a self-contained DSH Web client plugin.
 *
 * Everything below the two registration calls is vendored source that ships in
 * this repository under `vendor/`:
 *
 * - `vendor/ui-space` renders the whole Space module (`SpaceApp`).
 * - `vendor/mock-space` is the browser-local data layer; its demo seed is
 *   cleaned at boot, see `plugin-data.js`.
 * - `vendor/ui-system` supplies the shared controls and the `--alter-*` tokens.
 *
 * Only the assembly seam is local to `src/`: this file maps
 * `SpaceCapabilities` onto the DSH shell (a root-scoped `main` panel keyed
 * `alter-space` plus the matching `sidebar.panellist` entry, whose id addresses
 * that key).
 */
import { createElement, useEffect } from 'react';
import { Orbit } from 'lucide-react';
import { SpaceApp } from '@alter/ui-space/SpaceApp';
import { createSpaceService } from '@alter/mock-space';
import { cleanDemoData, prepareSpaceService } from './plugin-data.js';
import { createSpaceRouter } from './router.js';
import resetCss from './global-reset.css?inline';
import '@alter/ui-system/tokens.css';
import './host.css';

/** Main-panel key; the sidebar panel entry reuses the same id. */
const PANEL_ID = 'alter-space';
/** Locale namespace for plugin-owned UI copy. */
const NS = 'alter-space';
const dictionaries = {
  zh: { panel: '空间' },
  en: { panel: 'Space' },
};

/* One service and one route source per client run: switching panels unmounts
 * the view but keeps the Space session state, like the product's module.
 * Existing demo seed data is removed before the service reads its storage. */
cleanDemoData();
const service = prepareSpaceService(createSpaceService());
const router = createSpaceRouter();

function SpacePanel() {
  useEffect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@alter-dsh/space';
    tag.dataset.pluginReset = 'box-sizing';
    tag.textContent = resetCss;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, []);

  return createElement(
    'div',
    { className: 'alter-space-host' },
    createElement(SpaceApp, { service, router }),
  );
}

function SpaceIcon({ size = 18 }) {
  return createElement(Orbit, {
    size,
    strokeWidth: 1.6,
    'aria-hidden': 'true',
  });
}

export const inject = ['slots', 'locale'];

/**
 * Register the Space panel and its sidebar entry.
 * @param ctx - the client root context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'alter-space: dictionaries',
  );
  const t = ctx.locale.bind(NS);

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, SpacePanel),
  );

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('panel'),
      },
      SpaceIcon,
    ),
  );
}
