// @vitest-environment jsdom
/**
 * 新建文档后的路由落点。
 *
 * 路由是 React 之外的内存 store：它通知后触发的渲染，可能先于同一批 `setNodes`
 * 更新提交。`SpaceApp` 的「路由校正」会在目标 id 不在文档列表时回退（上一篇文档，
 * 空间为空时是空间概览），因此新建流程必须先把新文档发布到列表，再导航。
 *
 * 这里在 `router.navigate` 回调里断言调用瞬间侧栏已经列出新文档——正是浏览器里
 * 触发「新建后跳概览」的时序；同时断言最终停在新建文档的编辑器上。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpaceRouter } from '@alter/ui-space';
import { createSpaceAuthority } from '../host/authority.js';
import { createStructuredSpaceService } from '../host/document/notes.js';
import { createDocumentService } from '../host/document/service.js';
import { createSpaceRpc } from '../host/rpc.js';
import { createSpaceStorage } from '../host/storage.js';
import { openSpaceStore } from '../host/store.js';
import { attachDocumentClient } from '../src/document/client-access';
import {
  createSpaceClient,
  createSpaceDocumentClient,
} from '../src/space-client';
import { SpaceApp } from '../vendor/ui-space/src/SpaceApp';

if (typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown })
  .ResizeObserver;

const dirs: string[] = [];
const signal = new AbortController().signal;
const fixedNow = () => new Date('2026-11-06T00:00:00.000Z');

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
});

afterEach(async () => {
  cleanup();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalResizeObserver;
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface DocNavigation {
  /** 目标内存路由，如 `#/space/sp-1/doc/doc-2`。 */
  to: string;
  /** 导航瞬间侧栏已列出的文档数；新建文档必须已经计入。 */
  listedDocs: number;
}

function createRouter(): SpaceRouter & { docNavigations: DocNavigation[] } {
  let path = '#/space';
  const docNavigations: DocNavigation[] = [];
  const listeners = new Set<() => void>();
  return {
    docNavigations,
    getPath: () => path,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate(next: string) {
      if (next === path) return;
      if (/\/doc\/doc-[^/]+$/.test(next))
        docNavigations.push({
          to: next,
          listedDocs: document.querySelectorAll(
            '[aria-label="空间文档"] [data-actions]',
          ).length,
        });
      path = next;
      for (const listener of listeners) listener();
    },
  };
}

async function renderApp() {
  const dir = await mkdtemp(join(tmpdir(), 'alter-space-nav-'));
  dirs.push(dir);
  await mkdir(join(dir, 'home'), { recursive: true });
  const store = await openSpaceStore({ directory: dir, now: fixedNow });
  const document = createDocumentService({ store, now: fixedNow });
  const authority = createStructuredSpaceService(
    createSpaceAuthority(store, fixedNow),
    document,
  );
  const handler = createSpaceRpc({
    service: authority,
    storage: createSpaceStorage({ store, directory: dir }),
    workspaceSync: undefined,
    document,
    assets: undefined,
  });
  // 与 DSH Connection 的响应信封一致：fetch 路由把 `{ value }` 包成 RPC 值。
  const rpc = {
    async call(
      _channel: string,
      _endpoint: string,
      payload: unknown,
    ): Promise<{ ok: true; value: unknown }> {
      const { op, args } = payload as { op: string; args: unknown[] };
      const result = await handler(op, { args }, signal, {});
      return { ok: true, value: result };
    },
  };
  const service = attachDocumentClient(
    createSpaceClient(rpc),
    createSpaceDocumentClient(rpc),
  );
  const router = createRouter();
  render(createElement(SpaceApp, { service, router } as never));
  return { router, store };
}

describe('新建文档后的路由落点', () => {
  it('空空间新建文档时直接打开该文档，而不是空间概览', async () => {
    const { router, store } = await renderApp();
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(screen.getByLabelText('文档正文')).toBeTruthy();
    });
    const [navigation] = router.docNavigations;
    expect(navigation?.listedDocs).toBe(1);
    expect(router.getPath()).toMatch(/\/doc\/doc-[^/]+$/);
    expect(screen.queryByText('空间详情')).toBeNull();
    await store.close();
  });

  it('已有文档时新建文档打开新文档，而不是上一篇', async () => {
    const { router, store } = await renderApp();
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(router.getPath()).toMatch(/\/doc\/doc-[^/]+$/);
    });
    const firstDoc = router.getPath();

    await act(async () => {
      fireEvent.click(
        document.querySelector(
          'button[aria-label="新建"]',
        ) as HTMLButtonElement,
      );
    });
    fireEvent.click(await screen.findByText('新建文档'));
    await waitFor(() => {
      expect(router.getPath()).not.toBe(firstDoc);
      expect(screen.getByLabelText('文档正文')).toBeTruthy();
    });
    const last = router.docNavigations.at(-1);
    expect(last?.listedDocs).toBe(2);
    expect(router.getPath()).toBe(last?.to);
    await store.close();
  });
});
