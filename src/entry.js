/**
 * The Space feature as a self-contained DSH Web client plugin.
 *
 * The Space UI and data-layer sources live under `vendor/`; the Host half
 * (`lib/host`) owns a SQLite-backed Space authority.
 * This file is the client assembly seam: it mounts `SpaceApp` on the Host via
 * `ctx.connection.rpc` and registers the panel/sidebar entry.
 *
 * - `vendor/ui-space` renders the whole Space module (`SpaceApp`).
 * - `vendor/ui-system` supplies the shared controls and the `--alter-*` tokens.
 * - `src/space-client.ts` implements `SpaceService` over the Host RPC channel.
 */
import { createElement, useEffect } from 'react';
import { Orbit } from 'lucide-react';
import { attachDocumentClient } from './document/client-access';
import {
  createSpaceClient,
  createSpaceDocumentClient,
  createSpaceSettingsClient,
  createSpaceMigrationClient,
} from './space-client';
import { createSpaceStorageClient } from './storage-client';
import { createReloadContinuity } from './reload-continuity';
import { createSpaceRouter } from './router.js';
import { SpaceShell } from './space-shell';
import { DIRECTORY_PICKER_UNAVAILABLE } from './native-directory-field';
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

function SpacePanel({ service, storage, settings, migration, router, pickDirectory }) {
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
    createElement(SpaceShell, {
      service,
      storage,
      settings,
      migration,
      router,
      pickDirectory,
    }),
  );
}

/**
 * Resolve the host directory picker on demand.
 *
 * DSH's client workspace domain owns the same picker its own "add workspace"
 * flow uses: native folder dialog on desktop, DSH browse dialog in the web
 * profile. The service is read lazily (apply may run before it is active) and
 * a dedicated error code lets the field fall back to the built-in browser.
 * @param ctx - the client plugin context.
 */
function createHostDirectoryPicker(ctx, settings) {
  return async () => {
    // Server mode lists the server's filesystem; the host's native picker
    // would return a local path with no meaning there.
    const snapshot = await settings.get().catch(() => null);
    if (snapshot?.mode === 'server') {
      const error = new Error('服务端模式使用远端目录浏览或手工输入');
      error.code = DIRECTORY_PICKER_UNAVAILABLE;
      throw error;
    }
    const ui =
      typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
    if (ui === undefined || typeof ui.pickDirectory !== 'function') {
      const error = new Error('当前宿主不支持系统目录选择');
      error.code = DIRECTORY_PICKER_UNAVAILABLE;
      throw error;
    }
    const picked = await ui.pickDirectory();
    return typeof picked === 'string' && picked.trim() !== ''
      ? picked.trim()
      : null;
  };
}

function SpaceIcon({ size = 18 }) {
  return createElement(Orbit, {
    size,
    strokeWidth: 1.6,
    'aria-hidden': 'true',
  });
}

export const inject = ['slots', 'locale', 'connection', 'layout'];

/**
 * Register the Space panel and its sidebar entry.
 * @param ctx - the client root context.
 */
export function apply(ctx) {
  const rpc = ctx.connection.rpc;
  const service = attachDocumentClient(
    createSpaceClient(rpc),
    createSpaceDocumentClient(rpc),
  );
  const storage = createSpaceStorageClient(rpc);
  const settings = createSpaceSettingsClient(rpc);
  const migration = createSpaceMigrationClient(rpc);
  const router = createSpaceRouter();
  // DSH replaces this module in place when client.js is rebuilt; the page
  // record keeps the reader's panel and route across that replacement.
  const continuity = createReloadContinuity(ctx.layout, ctx.slots, PANEL_ID);
  const pickDirectory = createHostDirectoryPicker(ctx, settings);

  function SpaceView() {
    return createElement(SpacePanel, {
      service,
      storage,
      settings,
      migration,
      router,
      pickDirectory,
    });
  }

  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'alter-space: dictionaries',
  );
  ctx.effect(
    () => () => continuity.dispose(),
    'alter-space: reload continuity',
  );
  const t = ctx.locale.bind(NS);

  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      { name: 'main', key: PANEL_ID },
      SpaceView,
    );
    // Selecting the panel needs its entry registered. A replacement that
    // interrupted the reader is restored here, before the layout settles on
    // the Conversation for the rest of the session.
    continuity.restore();
    return dispose;
  });

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
