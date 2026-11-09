/**
 * DSH panel shell around the vendored Space app.
 *
 * Upstream Alter mounts `SettingsPage` as a separate client module reached by
 * the `#/settings` route. The DSH port exposes one main panel for the whole
 * Space feature, so this shell routes the in-memory Space router instead:
 * `#/settings` renders the reused settings page (AI collaborators, archive
 * management, shortcuts, about), every other path renders `SpaceApp`. A
 * floating back control and Escape return to the route the user left, where
 * `SpaceApp` remounts and reloads the collaborator roster; a collaborator
 * created here can then be selected in a space's configuration.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ArrowLeft } from 'lucide-react';
import { SpaceApp } from '@alter/ui-space/SpaceApp';
import { SettingsPage } from '@alter/ui-settings/SettingsPage';
import type { SpaceRouter } from '@alter/ui-space';
import type { SpaceService } from '@alter/protocol';
import { StorageSettingsSection } from './storage-settings';
import type { SpaceStorageClient } from './storage-client';

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
}

export function SpaceShell({ service, router, storage }: SpaceShellProps) {
  const path = useSyncExternalStore(
    router.subscribe,
    router.getPath,
    router.getPath,
  );
  const settings = isSettingsPath(path);
  const previousPath = useRef(DEFAULT_SPACE_PATH);

  // Remember the last Space route so "返回空间" restores the page the user
  // opened settings from (configuration, a document, …) instead of home.
  useEffect(() => {
    if (!settings) previousPath.current = path;
  }, [path, settings]);

  function returnToSpace() {
    const target = previousPath.current;
    router.navigate(isSettingsPath(target) ? DEFAULT_SPACE_PATH : target);
  }

  useEffect(() => {
    if (!settings) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Keep Escape for the focused control (e.g. clearing an input) rather
      // than leaving the page and dropping an unsaved collaborator draft.
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

  if (!settings) return <SpaceApp service={service} router={router} />;

  return (
    <div className="alter-space-settings">
      <button
        type="button"
        className="alter-space-settings-back"
        onClick={returnToSpace}
      >
        <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        返回空间
      </button>
      <div className="alter-space-settings-scroll">
        <SettingsPage service={service} />
        {storage ? <StorageSettingsSection storage={storage} /> : null}
      </div>
    </div>
  );
}
