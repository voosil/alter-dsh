/**
 * Module-level holder for the services the right-sidebar Space page tab
 * consumes.
 *
 * The tab body is registered as a slot component while the plugin assembly
 * owns the Host-backed `SpaceService`; this seam decouples the two the same
 * way `src/integration/bridge.ts` does: the assembly calls
 * `setSpacePageServices(...)` once at apply time, and the tab body reads the
 * holder at render time — showing an 「空间页面不可用」 placeholder when the
 * services are not wired (yet). Tests may swap the holder via the setter's
 * return value.
 *
 * The same module is the assembly seam for the vendor-side bridge singleton:
 * `setUiBridge` re-exports `vendor/ui-space/src/bridge.ts` so the entry half
 * installs both from one place (`setSpacePageServices({ service })` and
 * `setUiBridge(bridge)`, passing `null` on unload). The tab body itself never
 * consumes the bridge — the vendor app reads it where it needs it.
 */
import type { SpaceService } from '@alter/protocol';

export {
  setUiBridge,
  uiBridge,
} from '@alter/ui-space/bridge';
export type { SpaceBridgeLike } from '@alter/ui-space/bridge';

/** Services the Space page tab body consumes. */
export interface SpacePageServices {
  /** The plugin's SpaceService over the Host RPC channel. */
  service: SpaceService;
}

let services: SpacePageServices | null = null;

/** Install the tab services; returns the previous value (tests may swap). */
export function setSpacePageServices(
  next: SpacePageServices | null,
): SpacePageServices | null {
  const previous = services;
  services = next;
  return previous;
}

/** The installed services, or null before assembly wires them. */
export function spacePageServices(): SpacePageServices | null {
  return services;
}
