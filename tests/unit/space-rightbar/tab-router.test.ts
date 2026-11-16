/**
 * Route plumbing of the right-sidebar Space page tab: params parsing, target
 * resolution, revision-driven re-navigation and the private in-memory router.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPACE_PAGE_PATH,
  createSpacePageTabRouter,
  decideTabNavigation,
  initialSpacePageTabPath,
  parseSpacePageParams,
  spacePageTabTarget,
} from '../../../src/space-rightbar/tab-router';

describe('parseSpacePageParams', () => {
  it('reads non-empty string ids and drops everything else', () => {
    expect(parseSpacePageParams({ spaceId: 'sp_1', nodeId: 'nd_2' })).toEqual({
      spaceId: 'sp_1',
      nodeId: 'nd_2',
    });
    expect(parseSpacePageParams({ spaceId: 'sp_1', nodeId: 42 })).toEqual({
      spaceId: 'sp_1',
    });
    expect(parseSpacePageParams({ spaceId: '' })).toEqual({});
    expect(parseSpacePageParams({ spaceId: '   ' })).toEqual({});
    expect(parseSpacePageParams({ nodeId: 'nd_2' })).toEqual({ nodeId: 'nd_2' });
  });

  it('treats non-object params as no target', () => {
    expect(parseSpacePageParams(undefined)).toEqual({});
    expect(parseSpacePageParams(null)).toEqual({});
    expect(parseSpacePageParams('sp_1')).toEqual({});
    expect(parseSpacePageParams(42)).toEqual({});
    expect(parseSpacePageParams(['sp_1'])).toEqual({});
  });
});

describe('route targets', () => {
  it('maps spaceId + nodeId to the document route', () => {
    expect(spacePageTabTarget({ spaceId: 'sp', nodeId: 'nd' })).toBe(
      '#/space/sp/doc/nd',
    );
  });

  it('maps a bare spaceId to the space overview route', () => {
    expect(spacePageTabTarget({ spaceId: 'sp' })).toBe('#/space/sp');
  });

  it('has no target without a spaceId', () => {
    expect(spacePageTabTarget({})).toBeNull();
    expect(spacePageTabTarget({ nodeId: 'nd' })).toBeNull();
  });

  it('falls back to the app default when params carry no target', () => {
    expect(initialSpacePageTabPath({})).toBe(DEFAULT_SPACE_PAGE_PATH);
    expect(initialSpacePageTabPath({ spaceId: 'sp', nodeId: 'nd' })).toBe(
      '#/space/sp/doc/nd',
    );
    expect(initialSpacePageTabPath({ spaceId: 'sp' })).toBe('#/space/sp');
  });

  it('opens the guide tab on the app default for unparsed params', () => {
    expect(initialSpacePageTabPath(parseSpacePageParams(undefined))).toBe(
      DEFAULT_SPACE_PAGE_PATH,
    );
    expect(
      initialSpacePageTabPath(
        parseSpacePageParams({ spaceId: 'sp', nodeId: 'nd' }),
      ),
    ).toBe('#/space/sp/doc/nd');
  });
});

describe('decideTabNavigation', () => {
  const docRoute = '#/space/sp/doc/nd';

  it('navigates when a new revision carries a doc target', () => {
    expect(
      decideTabNavigation(
        { revision: null },
        { revision: 3, params: { spaceId: 'sp', nodeId: 'nd' } },
      ),
    ).toEqual({ revision: 3, path: docRoute });
  });

  it('navigates to the space route when only a spaceId is given', () => {
    expect(
      decideTabNavigation(
        { revision: 1 },
        { revision: 5, params: { spaceId: 'sp' } },
      ),
    ).toEqual({ revision: 5, path: '#/space/sp' });
  });

  it('stays put when the revision is unchanged', () => {
    expect(
      decideTabNavigation(
        { revision: 3 },
        { revision: 3, params: { spaceId: 'sp', nodeId: 'nd' } },
      ),
    ).toEqual({ revision: 3, path: null });
  });

  it('keeps the current route when a new revision has no target', () => {
    expect(
      decideTabNavigation({ revision: 2 }, { revision: 7, params: undefined }),
    ).toEqual({ revision: 7, path: null });
  });

  it('ignores junk params on a new revision', () => {
    expect(
      decideTabNavigation({ revision: 1 }, { revision: 2, params: 'junk' }),
    ).toEqual({ revision: 2, path: null });
  });

  it('treats a missing navigation record as no change', () => {
    expect(decideTabNavigation({ revision: 4 }, null)).toEqual({
      revision: 4,
      path: null,
    });
    expect(decideTabNavigation({ revision: null }, undefined)).toEqual({
      revision: null,
      path: null,
    });
  });

  it('applies revision 0 — a real revision, not "none seen yet"', () => {
    expect(
      decideTabNavigation(
        { revision: null },
        { revision: 0, params: { spaceId: 'sp', nodeId: 'nd' } },
      ),
    ).toEqual({ revision: 0, path: docRoute });
  });
});

describe('createSpacePageTabRouter', () => {
  it('starts on the route the tab was opened with', () => {
    const router = createSpacePageTabRouter(
      initialSpacePageTabPath(
        parseSpacePageParams({ spaceId: 'sp', nodeId: 'nd' }),
      ),
    );
    expect(router.getPath()).toBe('#/space/sp/doc/nd');
  });

  it('falls back to the app default without a target', () => {
    const router = createSpacePageTabRouter(
      initialSpacePageTabPath(parseSpacePageParams(undefined)),
    );
    expect(router.getPath()).toBe(DEFAULT_SPACE_PAGE_PATH);
  });

  it('notifies subscribers on navigation and skips identical paths', () => {
    const router = createSpacePageTabRouter('#/space');
    const seen: string[] = [];
    const unsubscribe = router.subscribe(() => seen.push(router.getPath()));

    router.navigate('#/space/sp/doc/nd');
    router.navigate('#/space/sp/doc/nd');
    expect(seen).toEqual(['#/space/sp/doc/nd']);
    expect(router.getPath()).toBe('#/space/sp/doc/nd');

    unsubscribe();
    router.navigate('#/space');
    expect(router.getPath()).toBe('#/space');
    expect(seen).toEqual(['#/space/sp/doc/nd']);
  });

  it('accepts the replace option SpaceApp passes for route corrections', () => {
    const router = createSpacePageTabRouter('#/space');
    expect(() => router.navigate('#/space/sp', { replace: true })).not.toThrow();
    expect(router.getPath()).toBe('#/space/sp');
  });
});
