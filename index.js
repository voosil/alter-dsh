/**
 * Host half of the self-contained Space client plugin.
 *
 * The Space feature has no Host-side capability: its data layer is the
 * vendored browser-local service that ships inside the client bundle. This
 * entry exists so the package is an ordinary Loader row and its `dsh.client`
 * declaration joins the Web boot graph; all contribution code lives in
 * `client.js` (see `src/entry.js` and `build/build.mjs`).
 *
 * @module @alter-dsh/space
 */

/** Loader-visible no-op body; the browser half carries the feature. */
export function apply() {}
