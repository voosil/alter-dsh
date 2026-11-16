/**
 * Registration contract of the 「空间页面」 right-sidebar tab type: the tab
 * definition (kind, title, guide entry, keepMounted), the body slot key and
 * the cleanup that disposes both. These are the exact shapes the plugin
 * assembly and the DSH seat rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  SPACE_PAGE_TAB_ID,
  SPACE_PAGE_TAB_KIND,
  registerSpacePageTab,
} from '../../../src/space-rightbar/register';
import type { SpaceClientContext } from '../../../src/integration/dsh';

/** The guide entry the tab definition carries. */
interface RecordedGuideEntry {
  id: string;
  order: number;
  title: () => string;
  description?: () => string;
  icon?: unknown;
}

/** The tab-type definition as this test records it. */
interface RecordedTabDef {
  id: string;
  kind: string;
  priority: string;
  keepMounted?: boolean;
  title: (address: string) => string;
  guide: RecordedGuideEntry[];
}

/** `ctx.sidebarRightTabs` double: records defs, disposer removes the def. */
class FakeSidebarRightTabs {
  readonly defs: RecordedTabDef[] = [];
  private disposed = 0;

  register(def: Record<string, unknown>): () => void {
    const recorded = def as unknown as RecordedTabDef;
    this.defs.push(recorded);
    return () => {
      this.disposed += 1;
      const index = this.defs.indexOf(recorded);
      if (index >= 0) this.defs.splice(index, 1);
    };
  }

  get disposeCount(): number {
    return this.disposed;
  }
}

interface RecordedSlot {
  options: Record<string, unknown>;
  body: unknown;
}

/** `ctx.slots` double: records body registrations, disposer removes the slot. */
class FakeSlots {
  readonly registered: RecordedSlot[] = [];
  private disposed = 0;

  register(options: Record<string, unknown>, body: unknown): () => void {
    this.registered.push({ options, body });
    return () => {
      this.disposed += 1;
      const index = this.registered.findIndex((slot) => slot.body === body);
      if (index >= 0) this.registered.splice(index, 1);
    };
  }

  /** The real seat is declared by another plugin; the double runs the callback now. */
  inject(_key: string, callback: () => () => void): () => void {
    return callback();
  }

  get disposeCount(): number {
    return this.disposed;
  }
}

function fakeContext(
  tabs: FakeSidebarRightTabs | undefined,
  slots: FakeSlots,
): SpaceClientContext {
  return {
    slots: slots as unknown as SpaceClientContext['slots'],
    sessions: {} as SpaceClientContext['sessions'],
    uiWorkspace: {} as SpaceClientContext['uiWorkspace'],
    sidebarRight: {} as SpaceClientContext['sidebarRight'],
    sidebarRightTabs: tabs as unknown as SpaceClientContext['sidebarRightTabs'],
    connection: {} as SpaceClientContext['connection'],
  };
}

describe('registerSpacePageTab', () => {
  it('registers the tab type with kind, title, keepMounted and the guide entry', () => {
    const tabs = new FakeSidebarRightTabs();
    const slots = new FakeSlots();
    const dispose = registerSpacePageTab(fakeContext(tabs, slots));
    expect(typeof dispose).toBe('function');

    expect(tabs.defs).toHaveLength(1);
    const def = tabs.defs[0]!;
    expect(def.id).toBe('@alter-dsh/space/space-page');
    expect(def.kind).toBe('alter-space.page');
    expect(def.priority).toBe('extension');
    expect(def.keepMounted).toBe(true);
    expect(def.title('#/anything')).toBe('空间');

    expect(def.guide).toHaveLength(1);
    const guide = def.guide[0]!;
    expect(guide.id).toBe('space-page');
    expect(guide.order).toBe(5);
    expect(guide.title()).toBe('空间页面');
    expect(guide.description?.()).toBe('在右侧打开空间页面，或直接新建对话');
    expect(typeof guide.icon).toBe('function');

    expect(slots.registered).toHaveLength(1);
    expect(tabs.disposeCount).toBe(0);
    expect(slots.disposeCount).toBe(0);
  });

  it('mounts the body on the sidebar.right.pane.tab slot under the same id', () => {
    const slots = new FakeSlots();
    registerSpacePageTab(fakeContext(new FakeSidebarRightTabs(), slots));

    const slot = slots.registered[0]!;
    expect(slot.options).toEqual({
      name: 'sidebar.right.pane.tab',
      key: SPACE_PAGE_TAB_ID,
    });
    expect(slot.options.key).toBe(SPACE_PAGE_TAB_ID);
    expect(typeof slot.body).toBe('function');
    // The body is a function component, not a rendered element.
    expect(slot.body).not.toBeNull();
  });

  it('exposes the constants the opener and the slot key agree on', () => {
    expect(SPACE_PAGE_TAB_KIND).toBe('alter-space.page');
    expect(SPACE_PAGE_TAB_ID).toBe('@alter-dsh/space/space-page');
  });

  it('disposes the body first and then the tab type', () => {
    const tabs = new FakeSidebarRightTabs();
    const slots = new FakeSlots();
    const dispose = registerSpacePageTab(fakeContext(tabs, slots));

    dispose();
    expect(slots.registered).toHaveLength(0);
    expect(tabs.defs).toHaveLength(0);
    expect(slots.disposeCount).toBe(1);
    expect(tabs.disposeCount).toBe(1);
  });

  it('is a no-op without the sidebarRightTabs service (older host)', () => {
    const slots = new FakeSlots();
    const dispose = registerSpacePageTab(fakeContext(undefined, slots));
    expect(typeof dispose).toBe('function');
    expect(slots.registered).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
    expect(slots.registered).toHaveLength(0);
  });
});
