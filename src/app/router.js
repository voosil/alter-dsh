/**
 * In-memory route source for the Space module.
 *
 * The Space UI expects a `SpaceRouter` capability
 * (`getPath`/`subscribe`/`navigate`). The DSH shell owns the browser URL, so
 * this router keeps the same contract over page-local state. Routes survive
 * panel switches (the module stays loaded) and client-module replacements
 * within the page (the page record lives in `reload-continuity`); a document
 * reload starts again at the default route. The host location is never
 * touched.
 */

import {
  DEFAULT_SPACE_PATH,
  spaceContinuity,
} from './reload-continuity';

export function createSpaceRouter() {
  const continuity = spaceContinuity();
  let path = continuity.path.startsWith('#/')
    ? continuity.path
    : DEFAULT_SPACE_PATH;
  const listeners = new Set();

  return {
    getPath: () => path,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate(next) {
      if (next === path) return;
      path = next;
      continuity.path = next;
      for (const listener of listeners) listener();
    },
  };
}
