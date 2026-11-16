/**
 * Right-sidebar activation: the decision layer that made a dead switch work.
 *
 * DSH's right column is per Session. The Space panel is a root-scoped main
 * panel, so while it fills the centre there is no column to expand and
 * `ctx.sidebarRight` throws on every write — the original silent catch is what
 * users saw as "the switch does nothing". These cases pin the three outcomes
 * and the "bring a Conversation up first" path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rightbarAvailable, toggleSpaceRightbar } from '../../../src/integration/rightbar';

/** A sidebar double whose writes throw unless a Session is on screen. */
function sidebarDouble(mountedId: string | undefined) {
  const calls = { toggle: 0, tabs: [] as unknown[] };
  let current = mountedId;
  let expanded = false;
  return {
    calls,
    setMounted(id: string | undefined) {
      current = id;
    },
    readonlyMounted: {
      getSnapshot: () => current,
    },
    sidebar: {
      mounted: { getSnapshot: () => current },
      toggleExpanded() {
        calls.toggle += 1;
        if (current === undefined) throw new Error('no session surface is mounted');
        expanded = !expanded;
      },
      isExpanded: () => expanded,
      openTab(_kind: string, options?: Record<string, unknown>) {
        calls.tabs.push(options);
        if (current === undefined) throw new Error('no session surface is mounted');
      },
      openResource() {
        if (current === undefined) throw new Error('no session surface is mounted');
      },
    },
  };
}

/** A client context double: only the faces the decision layer touches. */
function contextOf(options: {
  sidebar: ReturnType<typeof sidebarDouble>['sidebar'];
  ids?: string[];
  connect?: (workspaceId: string) => Promise<string>;
  start?: (workspaceId?: string | undefined) => void;
  openSession?: (id: string) => void;
}) {
  const ids = options.ids ?? [];
  const opened: string[] = [];
  return {
    opened,
    sidebarRight: options.sidebar,
    sessions: {
      list: {
        getSnapshot: () => ({
          ids,
          byId: Object.fromEntries(ids.map((id) => [id, { blank: true as const }])),
        }),
      },
      fork: vi.fn(),
      archiveSession: vi.fn(),
    },
    uiWorkspace: {
      openSession: (id: string) => {
        opened.push(id);
        options.openSession?.(id);
      },
      openWorkspace: vi.fn(),
      ...(options.connect === undefined
        ? {}
        : { connectWorkspace: options.connect }),
      ...(options.start === undefined ? {} : { startSession: options.start }),
    },
    connection: { rpc: { call: vi.fn() } },
  };
}

/** Frames/timers the engagement path waits on. */
const realRaf = globalThis.requestAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  vi.useRealTimers();
});

/** Run the next frame immediately so the engagement path stays synchronous. */
function immediateFrames(): void {
  globalThis.requestAnimationFrame = ((callback: () => void) => {
    callback();
    return 0;
  }) as never;
}

describe('rightbar availability', () => {
  it('is available only while a Session is on screen', () => {
    const mounted = sidebarDouble('se_1');
    expect(
      rightbarAvailable(contextOf({ sidebar: mounted.sidebar }) as never),
    ).toBe(true);
    mounted.setMounted(undefined);
    expect(
      rightbarAvailable(contextOf({ sidebar: mounted.sidebar }) as never),
    ).toBe(false);
  });
});

describe('toggleSpaceRightbar', () => {
  it('never collapses an open column when the caller only wants it shown', async () => {
    const double = sidebarDouble('se_1');
    const ctx = contextOf({ sidebar: double.sidebar });
    // The reader already has the column open for another surface.
    double.sidebar.toggleExpanded();
    expect(double.sidebar.isExpanded()).toBe(true);
    const outcome = await toggleSpaceRightbar(ctx as never, {
      spaceId: 'sp_1',
      openPage: false,
      expandOnly: true,
    });
    expect(outcome).toBe('toggled');
    expect(double.calls.toggle).toBe(1);
    expect(double.sidebar.isExpanded()).toBe(true);
  });

  it('expands a collapsed column for the same request', async () => {
    const double = sidebarDouble('se_1');
    const ctx = contextOf({ sidebar: double.sidebar });
    const outcome = await toggleSpaceRightbar(ctx as never, {
      spaceId: 'sp_1',
      openPage: false,
      expandOnly: true,
    });
    expect(outcome).toBe('toggled');
    expect(double.calls.toggle).toBe(1);
    expect(double.sidebar.isExpanded()).toBe(true);
  });

  it('toggles in place and opens the page beside it when a Session exists', async () => {
    const double = sidebarDouble('se_1');
    const ctx = contextOf({ sidebar: double.sidebar });
    const outcome = await toggleSpaceRightbar(ctx as never, {
      spaceId: 'sp_1',
      nodeId: 'doc_1',
    });
    expect(outcome).toBe('toggled');
    expect(double.calls.toggle).toBe(1);
    expect(double.calls.tabs).toEqual([
      { params: { spaceId: 'sp_1', nodeId: 'doc_1' } },
    ]);
    // No navigation: the reader stays where they were.
    expect(ctx.opened).toEqual([]);
  });

  it('resolves a Session for the column without leaving the Space panel', async () => {
    immediateFrames();
    const double = sidebarDouble(undefined);
    const connect = vi.fn(async () => {
      // Selecting a Session is what the column reads; the centre stays put.
      double.setMounted('se_new');
      return 'se_new';
    });
    const ctx = contextOf({ sidebar: double.sidebar, connect });
    // The workspace binding lookup answers over RPC; no binding here.
    (ctx.connection.rpc.call as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { workspaceId: 'ws_1' },
    });

    const outcome = await toggleSpaceRightbar(ctx as never, {
      spaceId: 'sp_1',
      nodeId: 'doc_1',
    });
    expect(outcome).toBe('engaged');
    expect(connect).toHaveBeenCalledWith('ws_1');
    // The whole point: no navigation, the reader keeps the page in the centre.
    expect(ctx.opened).toEqual([]);
    expect(double.calls.toggle).toBe(1);
    expect(double.calls.tabs).toEqual([
      { params: { spaceId: 'sp_1', nodeId: 'doc_1' } },
    ]);
  });

  it('stays unavailable when the space has no workspace to borrow a Session from', async () => {
    immediateFrames();
    const double = sidebarDouble(undefined);
    const connect = vi.fn(async () => 'se_never');
    const ctx = contextOf({ sidebar: double.sidebar, connect });
    // No workspace binding: the lookup answers with nothing.
    (ctx.connection.rpc.call as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { workspaceId: null },
    });
    const outcome = await toggleSpaceRightbar(ctx as never, {
      spaceId: 'sp_1',
      openPage: false,
    });
    expect(outcome).toBe('unavailable');
    expect(connect).not.toHaveBeenCalled();
    expect(double.calls.tabs).toEqual([]);
  });

  it('reports unavailable rather than doing nothing when nothing can be shown', async () => {
    immediateFrames();
    const double = sidebarDouble(undefined);
    const ctx = contextOf({ sidebar: double.sidebar });
    const outcome = await toggleSpaceRightbar(ctx as never, {});
    expect(outcome).toBe('unavailable');
    expect(double.calls.toggle).toBe(0);
  });
});
