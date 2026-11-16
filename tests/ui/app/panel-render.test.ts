// @vitest-environment jsdom
/**
 * The Space panel actually mounts.
 *
 * A missing import inside the panel component (`spaceBridge` was used but never
 * imported) threw at render time and React unmounted the whole panel, which the
 * user saw as "空间打不开". Unit tests cannot see that class of failure: the
 * plugin's `apply` succeeded, the registration was correct, and only rendering
 * the registered component exposes it. This case mounts the panel the way the
 * slot renderer does and fails on any console error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { apply } from '../../../src/entry.js';
import { installResizeObserver } from '../../support/document-page';

/** One space with one page, enough for the panel to render its content. */
const SPACE = {
  id: 'sp_1',
  name: '日常',
  goal: '',
  directories: [],
  collaboratorIds: [],
  isDefault: true,
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
};

const NOTE = {
  id: 'doc_1',
  spaceId: 'sp_1',
  kind: 'note',
  title: '页面 A',
  parentId: null,
  creator: 'me',
  pinned: false,
  archived: false,
  archivedBy: null,
  archivedAt: null,
  deletedAt: null,
  deletedRoot: false,
  originalParentId: null,
  unread: false,
  content: '',
  activity: 100,
  activityAt: '2026-01-01T00:00:00.000Z',
  lastOpenCreditAt: null,
  lastEditCreditAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  order: 0,
};

/** Registrations the fake slot service captured. */
interface Recorded {
  registers: Array<{ name: string; key?: string; id?: string }>;
  components: Map<string, ComponentType<Record<string, unknown>>>;
  injects: string[];
}

const roots: Root[] = [];

// jsdom has no ResizeObserver; the Space app's resizer and the panel chrome
// both need one to mount.
let restoreResizeObserver: () => void = () => {};
beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
});
afterEach(() => {
  restoreResizeObserver();
});

// React 19's `act` requires this flag; without it every act call warns.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  vi.restoreAllMocks();
});

/**
 * Build the client context double `apply` runs against.
 *
 * It answers the Space RPC with Host-shaped `{ value }` envelopes: the browser
 * client unwraps one envelope level, so a bare array here would look like an
 * object with no `value`.
 * @returns the context plus what the slot service recorded.
 */
function contextDouble(): { ctx: Record<string, unknown>; recorded: Recorded } {
  const recorded: Recorded = {
    registers: [],
    components: new Map(),
    injects: [],
  };
  const rpc = {
    call: async (_channel: string, _endpoint: string, payload: unknown) => {
      const op = (payload as { op?: string } | undefined)?.op ?? '';
      if (op === 'chat.listChats') return { ok: true, value: { value: [] } };
      if (op === 'space.getWorkspaceLink') {
        return { ok: true, value: { value: null } };
      }
      if (op === 'space.listSpaces') {
        return { ok: true, value: { value: [SPACE] } };
      }
      if (op === 'space.listNodes') {
        return { ok: true, value: { value: [NOTE] } };
      }
      if (op === 'space.listThoughts') return { ok: true, value: { value: [] } };
      if (op === 'space.listDeleted') {
        return { ok: true, value: { value: { nodes: [], thoughts: [] } } };
      }
      if (op === 'space.listAgents') return { ok: true, value: { value: [] } };
      // Every remaining list endpoint answers an empty list: the real Host
      // never returns undefined for these, and the page components assume it.
      if (op.startsWith('space.list')) return { ok: true, value: { value: [] } };
      if (op === 'doc.get') return { ok: true, value: { value: null } };
      return { ok: true, value: { value: null } };
    },
  };
  const noop = (): (() => void) => () => {};
  const ctx = {
    effect(run: () => unknown) {
      const dispose = run();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(_deps: string[], callback: (scope: unknown) => void) {
      callback(ctx);
    },
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      register(options: { name: string; key?: string; id?: string }, component: unknown) {
        recorded.registers.push(options);
        recorded.components.set(options.name, component as ComponentType);
        return () => {};
      },
      inject(key: string, callback: () => unknown) {
        recorded.injects.push(key);
        if (typeof callback === 'function') callback();
        return () => {};
      },
      registerFactory() {
        return () => {};
      },
    },
    locale: { register: noop, bind: () => (key: string) => key },
    connection: { rpc },
    layout: {
      selectPanel() {},
      toggleSidebar() {},
      openRightbar() {},
      closeRightbar() {},
      panelInfo: {
        getSnapshot: () => ({ activePanelId: null }),
        subscribe: () => () => {},
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} },
      retain: () => ({ sessionId: 'se_1', release() {} }),
      fork: async () => 'se_1',
      scope: () => undefined,
      binding: () => undefined,
      archiveSession: async () => {},
    },
    uiWorkspace: {
      openSession() {},
      openWorkspace: async () => {},
      connectWorkspace: async () => 'se_1',
    },
    sidebarRight: {
      openTab() {},
      openResource() {},
      toggleExpanded() {},
      mounted: { getSnapshot: () => undefined },
    },
    uiConversation: {
      userText: { register: noop },
      interactions: { register: noop },
      views: { register: noop },
    },
    resources: { register: noop },
    sidebarRightTabs: { register: noop },
  };
  return { ctx, recorded };
}

describe('Space panel mounts', () => {
  it('renders the registered main entry without a console error', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const message = args.map(String).join(' ');
      // Framework advice about the test environment is not a mount failure.
      if (message.includes('not configured to support act')) return;
      errors.push(message);
    });
    const { ctx, recorded } = contextDouble();

    expect(() => apply(ctx as never)).not.toThrow();
    const Main = recorded.components.get('main');
    expect(Main, 'the main panel entry must register').toBeTruthy();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(Main as ComponentType, {
          renderSlot: () => null,
          SessionProvider: ({ children }: { children: unknown }) =>
            createElement('div', null, children as never),
        }),
      );
    });

    // A render-time ReferenceError shows up as a React console error and an
    // empty tree; both must be absent.
    expect(errors).toEqual([]);
    expect(container.innerHTML.length).toBeGreaterThan(0);
    // The Space content itself rendered (the panel is not an empty shell).
    expect(container.textContent).toContain('页面 A');
    container.remove();
  });

  it('registers the panel in the sidebar list too', () => {
    const { ctx, recorded } = contextDouble();
    apply(ctx as never);
    expect(recorded.registers.map((entry) => entry.name)).toContain(
      'sidebar.panellist',
    );
  });
});
