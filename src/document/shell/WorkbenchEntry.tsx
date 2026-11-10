/**
 * Workbench toggle entry for the document shell.
 *
 * The old view rendered the toggle only when the Space context carried a
 * workbench controller and the document's scope was closed. The controller is
 * optional in `SpaceContextValue`, so the view skips this entry entirely when
 * assembly did not provide one (no crash, no dangling button).
 *
 * @module @alter-dsh/space/document/shell/WorkbenchEntry
 */
import { useSyncExternalStore } from 'react';
import {
  WorkbenchToggle,
  type WorkbenchController,
} from '@alter/ui-workbench';

/** Props of {@link WorkbenchEntry}. */
export interface WorkbenchEntryProps {
  controller: WorkbenchController;
  scopeKey: string;
}

/** Toggle button for the document workbench scope. */
export function WorkbenchEntry({ controller, scopeKey }: WorkbenchEntryProps) {
  const scope = useSyncExternalStore(
    controller.subscribe,
    () => controller.getScope(scopeKey),
  );
  // The open workbench already exposes its own toggle in its header.
  if (scope.open) return null;
  return <WorkbenchToggle controller={controller} scopeKey={scopeKey} />;
}
