import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { flushSync } from 'react-dom';
import type { Agent, Space, SpaceNode, Thought } from '@alter/protocol';
import { SpaceContext } from './runtime';
import type { SpaceCapabilities } from './types';
import {
  isSpaceRoutePath,
  parseSpaceRoute,
  docPath,
  thoughtsPath,
} from './space-route';
import { defaultDocId } from './utils/tree';
import {
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  useSidebarWidth,
} from './utils/useSidebarWidth';
import { Sidebar } from './components/Sidebar';
import { PanelResizer } from '@alter/ui-system';
import { SearchPanel } from './components/SearchPanel';
import { ThoughtComposerModal } from './components/ThoughtComposerModal';
import { CreateSpaceDialog } from './components/CreateSpaceDialog';
import { DocumentView } from './views/DocumentView';
import { ThoughtsView } from './views/ThoughtsView';
import { SpaceHubView } from './hub/plugins';
import { createSpaceHubRegistry } from './hub/registry';
import { SpaceHubProvider } from './hub/SpaceHubProvider';
import { TrashView } from './views/TrashView';
import { ArchiveView } from './views/ArchiveView';
import { SpaceHome } from './views/SpaceHome';
import { SpaceWorkbench } from './SpaceWorkbench';
import styles from './SpaceApp.module.css';

const LAST_SPACE_KEY = 'alter.space.last';
const LAST_DOC_PREFIX = 'alter.space.lastDoc.';

function readLastSpace() {
  try {
    return localStorage.getItem(LAST_SPACE_KEY);
  } catch {
    return null;
  }
}

function readLastDoc(spaceId: string) {
  try {
    return localStorage.getItem(LAST_DOC_PREFIX + spaceId);
  } catch {
    return null;
  }
}

function writeLastDoc(spaceId: string, docId: string) {
  try {
    localStorage.setItem(LAST_DOC_PREFIX + spaceId, docId);
  } catch {
    // Local persistence is best-effort.
  }
}

function preferredDocId(nodes: SpaceNode[], spaceId: string) {
  const stored = readLastDoc(spaceId);
  if (
    stored &&
    nodes.some((node) => node.id === stored && node.kind === 'note')
  )
    return stored;
  return defaultDocId(nodes);
}

export function SpaceApp({
  service,
  router,
  workbench,
  hubRegistry: providedRegistry,
}: SpaceCapabilities) {
  const [hubRegistry] = useState(createSpaceHubRegistry);
  const path = useSyncExternalStore(router.subscribe, router.getPath);
  const route = parseSpaceRoute(path);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const [nodes, setNodes] = useState<SpaceNode[]>([]);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loadedSpaceId, setLoadedSpaceId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const {
    width: sidebarWidth,
    resize: resizeSidebar,
    reset: resetSidebarWidth,
  } = useSidebarWidth();
  const spaceStyle =
    sidebarWidth === null
      ? undefined
      : ({
          '--alter-space-sidebar-width': `${sidebarWidth}px`,
        } as CSSProperties);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    void Promise.all([service.listSpaces(), service.listAgents()]).then(
      ([nextSpaces, nextAgents]) => {
        if (!active) return;
        setSpaces(nextSpaces);
        setAgents(nextAgents);
        setReady(true);
      },
    );
    return () => {
      active = false;
    };
  }, [service, version]);

  const activeSpace =
    spaces.find((space) => space.id === route.spaceId) ??
    spaces.find((space) => space.id === readLastSpace()) ??
    spaces.find((space) => space.isDefault) ??
    spaces[0];

  useEffect(() => {
    if (activeSpace)
      try {
        localStorage.setItem(LAST_SPACE_KEY, activeSpace.id);
      } catch {
        // Local persistence is best-effort.
      }
  }, [activeSpace]);

  useEffect(() => {
    if (!isSpaceRoutePath(path)) return;
    if (!ready || !activeSpace) return;
    if (route.spaceId !== activeSpace.id)
      router.navigate(
        `#/space/${activeSpace.id}${!route.spaceId && route.view === 'doc' ? '/doc' : ''}`,
        { replace: true },
      );
  }, [ready, activeSpace, route.spaceId, route.view, router, path]);

  useEffect(() => {
    if (!activeSpace) return;
    let active = true;
    const spaceId = activeSpace.id;
    void Promise.all([
      service.listNodes(spaceId),
      service.listThoughts(spaceId, { includeArchived: true }),
    ]).then(([nextNodes, nextThoughts]) => {
      if (!active) return;
      setNodes(nextNodes);
      setThoughts(nextThoughts);
      setLoadedSpaceId(spaceId);
    });
    return () => {
      active = false;
    };
  }, [service, activeSpace, version]);

  const visibleNodes = useMemo(
    () => (loadedSpaceId === activeSpace?.id ? nodes : []),
    [loadedSpaceId, activeSpace?.id, nodes],
  );
  const visibleThoughts = useMemo(
    () => (loadedSpaceId === activeSpace?.id ? thoughts : []),
    [loadedSpaceId, activeSpace?.id, thoughts],
  );

  useEffect(() => {
    if (!isSpaceRoutePath(path)) return;
    if (!activeSpace || loadedSpaceId !== activeSpace.id) return;
    if (route.view !== 'doc') return;
    if (route.id && visibleNodes.some((node) => node.id === route.id)) return;
    const target = preferredDocId(visibleNodes, activeSpace.id);
    if (target)
      router.navigate(docPath(activeSpace.id, target), { replace: true });
    else if (route.id)
      router.navigate(`#/space/${activeSpace.id}`, { replace: true });
  }, [activeSpace, loadedSpaceId, route, visibleNodes, router, path]);

  useEffect(() => {
    if (!isSpaceRoutePath(path)) return;
    if (!activeSpace || route.view !== 'doc' || !route.id) return;
    if (route.spaceId !== activeSpace.id) return;
    if (!visibleNodes.some((node) => node.id === route.id)) return;
    writeLastDoc(activeSpace.id, route.id);
  }, [activeSpace, path, route.id, route.spaceId, route.view, visibleNodes]);

  useEffect(() => {
    if (!isSpaceRoutePath(path)) return;
    if (!activeSpace || loadedSpaceId !== activeSpace.id) return;
    if (route.view !== 'thoughts' || !route.id) return;
    if (visibleThoughts.some((thought) => thought.id === route.id)) return;
    router.navigate(thoughtsPath(activeSpace.id), { replace: true });
  }, [activeSpace, loadedSpaceId, route, visibleThoughts, router, path]);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (key === 'e') {
        event.preventDefault();
        setComposerOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const context = useMemo(() => {
    if (!activeSpace) return null;
    return {
      service,
      router,
      spaces,
      agents,
      space: activeSpace,
      spaceId: activeSpace.id,
      nodes: visibleNodes,
      thoughts: visibleThoughts,
      version,
      refresh,
      toast,
      openSearch: () => setSearchOpen(true),
      openThoughtComposer: () => setComposerOpen(true),
      openDirectory: () => setDirectoryOpen(true),
      closeDirectory: () => setDirectoryOpen(false),
      removeSpaceFromState: (id: string) =>
        setSpaces((items) => items.filter((space) => space.id !== id)),
      addSpaceToState: (space: Space) =>
        setSpaces((items) => [...items, space]),
      // 新建路径紧接着跳转到这篇文档，而路由是外部 store：它的通知会先于同一批
      // `setNodes` 更新渲染。若文档列表此刻仍没有该 id，下面的路由校正会把新建文档
      // 误判为不存在，跳回上一篇文档；空间为空时则跳回空间概览。因此先把新节点同步
      // 提交到列表，再允许调用方导航。
      addNodeToState: (node: SpaceNode) => {
        flushSync(() => {
          setNodes((items) => [
            node,
            ...items.filter((item) => item.id !== node.id),
          ]);
          setLoadedSpaceId((current) => current ?? node.spaceId);
        });
      },
      updateNodeInState: (node: SpaceNode) =>
        setNodes((items) =>
          items.map((item) => (item.id === node.id ? node : item)),
        ),
    };
  }, [
    service,
    router,
    spaces,
    agents,
    activeSpace,
    visibleNodes,
    visibleThoughts,
    version,
    refresh,
    toast,
  ]);

  if (!ready) {
    return <div className={styles.loading}>正在打开空间…</div>;
  }

  if (!activeSpace || !context) {
    return <div className={styles.loading}>还没有可用的空间。</div>;
  }

  function renderView() {
    if (!activeSpace) return null;
    if (route.spaceId !== activeSpace.id)
      return <div className={styles.pending} aria-live="polite" />;
    if (route.view === 'thoughts')
      return <ThoughtsView key={activeSpace.id} selectedId={route.id} />;
    if (
      route.view === 'overview' ||
      route.view === 'config' ||
      route.view === 'plugin'
    )
      return (
        <SpaceHubView
          registry={providedRegistry ?? hubRegistry}
          key={`${activeSpace.id}:${route.view}:${route.id ?? ''}`}
          pluginId={
            route.view === 'plugin' ? (route.id ?? 'overview') : route.view
          }
        />
      );
    if (route.view === 'trash') return <TrashView key={activeSpace.id} />;
    if (route.view === 'archive')
      return (
        <ArchiveView
          key={`${activeSpace.id}-${route.id ?? 'docs'}`}
          initialTab={route.id === 'thoughts' ? 'thoughts' : 'docs'}
        />
      );
    const node = route.id
      ? visibleNodes.find((item) => item.id === route.id)
      : undefined;
    if (node) return <DocumentView key={node.id} node={node} />;
    if (loadedSpaceId === activeSpace.id && !defaultDocId(visibleNodes))
      return <SpaceHome />;
    return <div className={styles.pending} aria-live="polite" />;
  }

  return (
    <SpaceContext.Provider value={context}>
      <SpaceHubProvider>
        <div className={styles.space} style={spaceStyle}>
          <Sidebar
            asideRef={sidebarRef}
            open={directoryOpen}
            onClose={() => setDirectoryOpen(false)}
            onCreateSpace={() => setCreateSpaceOpen(true)}
          />
          <PanelResizer
            panelRef={sidebarRef}
            label="调整目录宽度"
            edge="right"
            min={MIN_SIDEBAR_WIDTH}
            max={MAX_SIDEBAR_WIDTH}
            className={styles.sidebarResizer}
            onResize={resizeSidebar}
            onReset={resetSidebarWidth}
          />
          <main className={styles.main} id="space-main">
            {workbench ? (
              <SpaceWorkbench
                controller={workbench.controller}
                service={workbench.service}
                terminal={workbench.terminal}
                scopeKey={`space:${activeSpace.id}:${route.view}:${route.id ?? ''}`}
                contextTitle={
                  visibleNodes.find((item) => item.id === route.id)?.title ||
                  activeSpace.name
                }
              >
                {renderView()}
              </SpaceWorkbench>
            ) : (
              renderView()
            )}
          </main>
          {directoryOpen ? (
            <button
              type="button"
              className={styles.scrim}
              aria-label="关闭空间目录"
              onClick={() => setDirectoryOpen(false)}
            />
          ) : null}
          {searchOpen ? (
            <SearchPanel open onClose={() => setSearchOpen(false)} />
          ) : null}
          {composerOpen ? (
            <ThoughtComposerModal open onClose={() => setComposerOpen(false)} />
          ) : null}
          {createSpaceOpen ? (
            <CreateSpaceDialog
              open
              onClose={() => setCreateSpaceOpen(false)}
              onCreated={(space) => {
                context.addSpaceToState(space);
                setCreateSpaceOpen(false);
                router.navigate(`#/space/${space.id}/overview`, {
                  replace: true,
                });
              }}
            />
          ) : null}
          {toastMessage ? (
            <div
              className={styles.toast}
              data-visible
              role="status"
              aria-live="polite"
            >
              {toastMessage}
            </div>
          ) : null}
        </div>
      </SpaceHubProvider>
    </SpaceContext.Provider>
  );
}
