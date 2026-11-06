import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, Menu } from '@alter/ui-system';
import { ChatView, useWorkbench, WorkbenchToggle } from '@alter/ui-workbench';
import type { Space, SpaceNode } from '@alter/protocol';
import { SpaceContext, type SpaceContextValue } from './runtime';
import type { SpaceCapabilities } from './types';
import { SpaceWorkbench } from './SpaceWorkbench';
import styles from './WorkbenchChatPage.module.css';

export function WorkbenchChatPage({
  service,
  router,
  workbench,
}: SpaceCapabilities) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [nodes, setNodes] = useState<SpaceNode[]>([]);
  const [loadedSpace, setLoadedSpace] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void service
      .listSpaces()
      .then((items) => {
        if (active) {
          setSpaces(items);
          setError('');
        }
      })
      .catch(() => {
        if (active) setError('空间读取失败，请重试');
      });
    return () => {
      active = false;
    };
  }, [service, version]);
  const space =
    spaces.find((item) => item.id === selected) ??
    spaces.find((item) => item.isDefault) ??
    spaces[0];
  useEffect(() => {
    if (!space) return;
    let active = true;
    void service
      .listNodes(space.id)
      .then((items) => {
        if (active) {
          setNodes(items);
          setLoadedSpace(space.id);
          setError('');
        }
      })
      .catch(() => {
        if (active) setError('文档读取失败，请重试');
      });
    return () => {
      active = false;
    };
  }, [space, service, version]);
  if (error)
    return (
      <div className={styles.status} role="alert">
        {error}
        <Button onClick={refresh}>重试</Button>
      </div>
    );
  if (!space || !workbench || loadedSpace !== space.id)
    return (
      <p className={styles.status} role="status">
        正在打开对话…
      </p>
    );
  const context: SpaceContextValue = {
    service,
    router,
    space,
    spaceId: space.id,
    spaces,
    nodes,
    agents: [],
    thoughts: [],
    version,
    refresh,
    toast: setNotice,
    openSearch: () => undefined,
    openThoughtComposer: () => undefined,
    openDirectory: () => undefined,
    closeDirectory: () => undefined,
    removeSpaceFromState: (id) =>
      setSpaces((items) => items.filter((item) => item.id !== id)),
    addSpaceToState: (item) => setSpaces((items) => [...items, item]),
    addNodeToState: (node) => setNodes((items) => [...items, node]),
    updateNodeInState: (node) =>
      setNodes((items) =>
        items.map((item) => (item.id === node.id ? node : item)),
      ),
  };
  const scopeKey = `chat:tools:${space.id}`;
  return (
    <SpaceContext.Provider value={context}>
      <SpaceWorkbench
        controller={workbench.controller}
        service={workbench.service}
        terminal={workbench.terminal}
        scopeKey={scopeKey}
        contextTitle={space.name}
      >
        <section className={styles.page} aria-label="对话">
          <header className={styles.toolbar}>
            <h1>对话</h1>
            <Button
              variant="ghost"
              onClick={(event) => setAnchor(event.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={Boolean(anchor)}
            >
              {space.name}
              <ChevronDown size={14} />
            </Button>
            <WorkbenchToggle
              hideWhenOpen
              controller={workbench.controller}
              scopeKey={scopeKey}
            />
          </header>
          <MainChat key={space.id} workbench={workbench} space={space} />
          {notice ? (
            <p role="status" className={styles.notice}>
              {notice}
            </p>
          ) : null}
        </section>
      </SpaceWorkbench>
      <Menu
        open={Boolean(anchor)}
        anchor={anchor}
        onClose={() => setAnchor(null)}
        actions={spaces.map((item) => ({
          id: item.id,
          label: item.name,
          onSelect: () => setSelected(item.id),
        }))}
      />
    </SpaceContext.Provider>
  );
}
function MainChat({
  workbench,
  space,
}: {
  workbench: NonNullable<SpaceCapabilities['workbench']>;
  space: Space;
}) {
  const key = `chat:main:${space.id}`;
  const [id] = useState(
    () =>
      workbench.controller.getScope(key).tabs[0]?.id ??
      workbench.controller.add(key, 'chat'),
  );
  const scope = useWorkbench(workbench.controller, key);
  const tab = scope.tabs.find((item) => item.id === id);
  return tab ? (
    <ChatView
      controller={workbench.controller}
      service={workbench.service}
      scopeKey={key}
      tab={tab}
      contextTitle={space.name}
    />
  ) : null;
}
