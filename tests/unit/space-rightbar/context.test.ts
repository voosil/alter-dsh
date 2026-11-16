/**
 * The right-sidebar assembly seam: the services holder swap semantics and the
 * vendor-bridge forwarding (`setUiBridge` re-export).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SpaceService } from '@alter/protocol';
import {
  setSpacePageServices,
  setUiBridge,
  spacePageServices,
  uiBridge,
} from '../../../src/space-rightbar/context';
import type { SpacePageServices } from '../../../src/space-rightbar/context';
import type { SpaceBridgeLike } from '../../../src/space-rightbar/context';

afterEach(() => {
  setSpacePageServices(null);
  setUiBridge(null);
});

describe('setSpacePageServices', () => {
  it('starts empty and swaps the holder, returning the previous value', () => {
    expect(spacePageServices()).toBeNull();

    const services: SpacePageServices = { service: {} as SpaceService };
    expect(setSpacePageServices(services)).toBeNull();
    expect(spacePageServices()).toBe(services);

    const next: SpacePageServices = { service: {} as SpaceService };
    expect(setSpacePageServices(next)).toBe(services);
    expect(spacePageServices()).toBe(next);
  });

  it('uninstalls with null', () => {
    const services: SpacePageServices = { service: {} as SpaceService };
    setSpacePageServices(services);
    expect(setSpacePageServices(null)).toBe(services);
    expect(spacePageServices()).toBeNull();
  });
});

describe('setUiBridge forwarding', () => {
  it('installs and uninstalls the vendor-side bridge singleton', () => {
    expect(uiBridge()).toBeNull();
    const bridge = {
      toggleRightbar: () => undefined,
      startPageChat: () => Promise.reject(new Error('unused')),
      relatedChats: () => Promise.resolve([]),
      openPageInRightbar: () => undefined,
      openChat: () => undefined,
      deleteChat: () => Promise.resolve(),
    } satisfies SpaceBridgeLike;
    setUiBridge(bridge);
    expect(uiBridge()).toBe(bridge);
    setUiBridge(null);
    expect(uiBridge()).toBeNull();
  });
});
