/**
 * DSH panel shell around the Space app.
 *
 * The Space settings page is mounted as a client module reached by
 * the `#/settings` route. The plugin exposes one main panel for the whole
 * Space feature, so this shell routes the in-memory Space router instead:
 * `#/settings` renders the Space settings page, every other path renders
 * `SpaceApp`. Escape and the page's back control return to the route the user
 * left, where `SpaceApp` remounts and reloads the collaborator roster.
 *
 * The shell also installs the host directory picker for the working-
 * directory field (see `src/native-directory-field.tsx`); the app
 * itself stays untouched.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { SpaceApp } from '@alter/ui-space/SpaceApp';
import type { SpaceRouter } from '@alter/ui-space';
import type { SpaceService } from '@alter/protocol';
import { SpaceSettingsPage } from './settings-page';
import {
  DirectoryPickerProvider,
  type DirectoryPicker,
} from './native-directory-field';
import type { SpaceStorageClient } from './storage-client';
import type {
  SpaceMigrationClient,
  SpaceSettingsClient,
} from './space-client';

/** In-panel route that opens the Space settings page. */
export const SETTINGS_PATH = '#/settings';
/** Fallback route when the previous location is itself a settings route. */
const DEFAULT_SPACE_PATH = '#/space';

function isSettingsPath(path: string): boolean {
  return path === SETTINGS_PATH || path.startsWith(`${SETTINGS_PATH}/`);
}

export interface SpaceShellProps {
  service: SpaceService;
  router: SpaceRouter;
  /** Storage policy client; omitted only by tests that do not need it. */
  storage?: SpaceStorageClient;
  /** Server/mode settings client; omitted only by tests that do not need it. */
  settings?: SpaceSettingsClient;
  /** Migration client; omitted only by tests that do not need it. */
  migration?: SpaceMigrationClient;
  /**
   * Host directory picker used by the working-directory field. Omitted by
   * tests and hosts without a picker (the built-in in-app browser is the
   * fallback).
   */
  pickDirectory?: DirectoryPicker;
}

export function SpaceShell({
  service,
  router,
  storage,
  settings,
  migration,
  pickDirectory,
}: SpaceShellProps) {
  const path = useSyncExternalStore(
    router.subscribe,
    router.getPath,
    router.getPath,
  );
  const showSettings = isSettingsPath(path);
  const previousPath = useRef(DEFAULT_SPACE_PATH);

  // Remember the last Space route so "返回空间" restores the page the user
  // opened settings from (configuration, a document, …) instead of home.
  useEffect(() => {
    if (!showSettings) previousPath.current = path;
  }, [path, showSettings]);

  function returnToSpace() {
    const target = previousPath.current;
    router.navigate(isSettingsPath(target) ? DEFAULT_SPACE_PATH : target);
  }

  useEffect(() => {
    if (!showSettings) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Keep Escape for the focused control (e.g. clearing an input) rather
      // than leaving the page and dropping an unsaved storage draft.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      )
        return;
      event.preventDefault();
      returnToSpace();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!showSettings)
    return (
      <DirectoryPickerProvider pickDirectory={pickDirectory}>
        <SpaceApp service={service} router={router} />
      </DirectoryPickerProvider>
    );

  return (
    <SpaceSettingsPage
      service={service}
      storage={storage}
      settings={settings}
      migration={migration}
      onBack={returnToSpace}
    />
  );
}
