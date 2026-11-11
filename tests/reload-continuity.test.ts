// @vitest-environment jsdom
/**
 * Client-module replacement continuity.
 *
 * DSH replaces a client bundle in place when its artifact is rebuilt. The
 * replacement disposes the old plugin fiber, so the layout drops the Space
 * `main` entry and falls back to the Conversation; the page record must keep
 * the reader on the Space panel and on the in-panel route. These tests drive
 * the bridge with the same layout/slot faces the client context provides.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { apply } from '../src/entry.js';
import {
  DEFAULT_SPACE_PATH,
  createReloadContinuity,
  spaceContinuity,
} from '../src/reload-continuity';
import { createSpaceRouter } from '../src/router.js';

const PANEL = 'alter-space';
const OTHER_PANEL = 'plugins';

interface ContinuityPage {
  __ALTER_SPACE_CONTINUITY__?: unknown;
}

function clearPageRecord(): void {
  delete (globalThis as ContinuityPage).__ALTER_SPACE_CONTINUITY__;
}

/** Layout service double: keeps one selected panel and notifies like ctx.layout. */
class FakeLayout {
  activePanelId: string | null = null;
  readonly selections: (string | null)[] = [];
  private readonly listeners = new Set<() => void>();

  readonly panelInfo = {
    getSnapshot: () => ({ activePanelId: this.activePanelId }),
    subscribe: (listener: () => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };

  selectPanel(panelId: string | null): void {
    this.selections.push(panelId);
    this.setActive(panelId);
  }

  /** What the layout does when the selected panel's entry disappears. */
  resetByLayout(): void {
    this.setActive(null);
  }

  private setActive(panelId: string | null): void {
    this.activePanelId = panelId;
    for (const listener of this.listeners) listener();
  }
}

/** Slot registry double whose `main` entry can leave during a replacement. */
function mainEntry() {
  const state: { key: string | undefined } = { key: PANEL };
  return {
    state,
    entries: (name: string) =>
      name === 'main' && state.key !== undefined
        ? [{ options: { key: state.key } }]
        : [],
  };
}

beforeEach(clearPageRecord);

describe('Space panel continuity across a client-module replacement', () => {
  it('restores the panel when the replacement interrupted the reader on Space', () => {
    const layout = new FakeLayout();
    const slots = mainEntry();
    const interrupted = createReloadContinuity(layout, slots, PANEL);
    layout.selectPanel(PANEL);
    expect(spaceContinuity().active).toBe(true);

    // Replacement teardown: the entry leaves first, then the layout clears.
    slots.state.key = undefined;
    layout.resetByLayout();
    interrupted.dispose();
    expect(spaceContinuity().active).toBe(true);
    expect(spaceContinuity().interruptedAt).toBeTypeOf('number');

    const replacement = createReloadContinuity(
      layout,
      mainEntry(),
      PANEL,
    );
    expect(replacement.restore()).toBe(true);
    expect(layout.activePanelId).toBe(PANEL);
    expect(spaceContinuity().interruptedAt).toBeUndefined();
  });

  it('keeps the reader when the layout clears the selection before teardown', () => {
    const layout = new FakeLayout();
    const first = createReloadContinuity(layout, mainEntry(), PANEL);
    layout.selectPanel(PANEL);

    first.dispose();
    layout.resetByLayout();
    expect(spaceContinuity().active).toBe(true);

    const replacement = createReloadContinuity(
      layout,
      mainEntry(),
      PANEL,
    );
    expect(replacement.restore()).toBe(true);
    expect(layout.activePanelId).toBe(PANEL);
  });

  it('leaves the Conversation alone after the reader chose it', () => {
    const layout = new FakeLayout();
    const slots = mainEntry();
    const first = createReloadContinuity(layout, slots, PANEL);
    layout.selectPanel(PANEL);
    layout.selectPanel(null);
    expect(spaceContinuity().active).toBe(false);
    expect(spaceContinuity().interruptedAt).toBeUndefined();

    first.dispose();
    const replacement = createReloadContinuity(
      layout,
      mainEntry(),
      PANEL,
    );
    expect(replacement.restore()).toBe(false);
    expect(layout.selections).toEqual([PANEL, null]);
  });

  it('does not steal the placement from another global panel', () => {
    const layout = new FakeLayout();
    const first = createReloadContinuity(layout, mainEntry(), PANEL);
    layout.selectPanel(PANEL);
    layout.selectPanel(OTHER_PANEL);
    expect(spaceContinuity().active).toBe(false);

    first.dispose();
    const replacement = createReloadContinuity(
      layout,
      mainEntry(),
      PANEL,
    );
    expect(replacement.restore()).toBe(false);
    expect(layout.activePanelId).toBe(OTHER_PANEL);
  });

  it('does not restore a stale interruption', () => {
    const layout = new FakeLayout();
    const first = createReloadContinuity(layout, mainEntry(), PANEL);
    layout.selectPanel(PANEL);
    first.dispose();
    layout.resetByLayout();
    spaceContinuity().interruptedAt = Date.now() - 60_000;

    const replacement = createReloadContinuity(
      layout,
      mainEntry(),
      PANEL,
    );
    expect(replacement.restore()).toBe(false);
    expect(spaceContinuity().active).toBe(false);
    expect(layout.activePanelId).toBeNull();
  });

  it('waits until the panel entry is registered again', () => {
    const layout = new FakeLayout();
    const first = createReloadContinuity(layout, mainEntry(), PANEL);
    layout.selectPanel(PANEL);
    first.dispose();
    layout.resetByLayout();

    const slots = mainEntry();
    slots.state.key = undefined;
    const replacement = createReloadContinuity(layout, slots, PANEL);
    expect(replacement.restore()).toBe(false);
    expect(layout.activePanelId).toBeNull();

    slots.state.key = PANEL;
    expect(replacement.restore()).toBe(true);
    expect(layout.activePanelId).toBe(PANEL);
  });

  it('shares one page record and replaces an unreadable one', () => {
    expect(spaceContinuity()).toBe(spaceContinuity());
    (globalThis as ContinuityPage).__ALTER_SPACE_CONTINUITY__ = {
      version: 0,
      active: true,
      path: '#/space/stale',
    };
    const fresh = spaceContinuity();
    expect(fresh.active).toBe(false);
    expect(fresh.path).toBe(DEFAULT_SPACE_PATH);
  });
});

describe('Space route continuity across a client-module replacement', () => {
  it('reopens the last route for the replacing module', () => {
    const first = createSpaceRouter();
    expect(first.getPath()).toBe(DEFAULT_SPACE_PATH);
    first.navigate('#/space/sp-1/doc/doc-2');

    const replacement = createSpaceRouter();
    expect(replacement.getPath()).toBe('#/space/sp-1/doc/doc-2');
  });

  it('starts at the default route on a document reload', () => {
    createSpaceRouter().navigate('#/space/sp-1/doc/doc-2');
    clearPageRecord();
    expect(createSpaceRouter().getPath()).toBe(DEFAULT_SPACE_PATH);
  });

  it('notifies subscribers only when the route changes', () => {
    const router = createSpaceRouter();
    let notifications = 0;
    const stop = router.subscribe(() => {
      notifications += 1;
    });
    router.navigate(DEFAULT_SPACE_PATH);
    expect(notifications).toBe(0);
    router.navigate('#/space/sp-1');
    expect(notifications).toBe(1);
    stop();
    router.navigate(DEFAULT_SPACE_PATH);
    expect(notifications).toBe(1);
  });
});

/** Client context double carrying only the faces `apply` touches. */
function pluginContext(layout: FakeLayout) {
  const registered: Array<{ options: { key?: string; id?: string } }> = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    connection: { rpc: {} },
    layout,
    get: () => undefined,
    effect: (run: () => unknown) => {
      const dispose = run();
      if (typeof dispose === 'function') disposers.push(dispose as () => void);
    },
    slots: {
      inject: (_name: string, register: () => unknown) => {
        register();
      },
      register: (options: { key?: string; id?: string }) => {
        registered.push({ options });
        return () => {};
      },
      entries: (name: string) => (name === 'main' ? registered : []),
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
  };
  return {
    ctx,
    registered,
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer();
    },
  };
}

describe('Space plugin apply after a client-module replacement', () => {
  it('re-selects the panel of an interrupted reader', () => {
    const layout = new FakeLayout();
    spaceContinuity().active = true;
    spaceContinuity().interruptedAt = Date.now();
    const plugin = pluginContext(layout);
    apply(plugin.ctx as never);
    expect(layout.selections).toEqual([PANEL]);
    expect(layout.activePanelId).toBe(PANEL);
    expect(plugin.registered.map((entry) => entry.options.key)).toContain(
      PANEL,
    );
    plugin.dispose();
  });

  it('keeps the Conversation when the reader chose it before the replacement', () => {
    const layout = new FakeLayout();
    const plugin = pluginContext(layout);
    apply(plugin.ctx as never);
    expect(layout.selections).toEqual([]);
    plugin.dispose();
  });
});
