/**
 * In-memory route source for the Space module.
 *
 * The Space UI expects a `SpaceRouter` capability
 * (`getPath`/`subscribe`/`navigate`). The DSH shell owns the browser URL, so
 * this router keeps the same contract over page-local state: routes survive
 * panel switches (the module stays loaded) but never touch the host location.
 */

const INITIAL_PATH = '#/space';

export function createSpaceRouter() {
  let path = INITIAL_PATH;
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
      for (const listener of listeners) listener();
    },
  };
}
