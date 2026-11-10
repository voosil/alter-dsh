import { MatterDetail } from './hub/MatterDetail';
import { EventDetail } from './hub/EventDetail';
import { HubConversation } from './hub/HubConversation';
import { useState, type ReactNode } from 'react';
import { WorkbenchFrame, type WorkbenchController } from '@alter/ui-workbench';
import type { WorkbenchService } from '@alter/mock-workbench';
import { SpaceContext, useSpaceContext } from './runtime';
import { SearchPanel } from './components/SearchPanel';
import { AlterDocumentView as DocumentView } from '@alter-space/document-view';
import { parseSpaceRoute } from './space-route';
import { displayTitle } from './utils/tree';

export function SpaceWorkbench({
  controller,
  service,
  terminal,
  scopeKey,
  contextTitle,
  children,
}: {
  controller: WorkbenchController;
  service: WorkbenchService;
  terminal: import('@alter/protocol').TerminalService;
  scopeKey: string;
  contextTitle: string;
  children: ReactNode;
}) {
  const context = useSpaceContext();
  const [searchOpen, setSearchOpen] = useState(false);
  function openDocument(id: string) {
    const node = context.nodes.find(
      (item) => item.id === id && item.kind === 'note' && !item.deletedAt,
    );
    if (node)
      controller.launch(scopeKey, 'document', {
        documentId: id,
        title: displayTitle(node.title),
      });
  }
  const value = {
    ...context,
    workbench: { controller, scopeKey },
    openWeb: (url: string) => controller.openLink(scopeKey, url),
  };
  return (
    <SpaceContext.Provider value={value}>
      <WorkbenchFrame
        controller={controller}
        service={service}
        terminal={terminal}
        scopeKey={scopeKey}
        directories={context.space.directories}
        contextTitle={contextTitle}
        onSearchDocument={() => setSearchOpen(true)}
        onDropDocument={openDocument}
        renderResource={(tab) =>
          tab.resourceType === 'matter' ? (
            <MatterDetail tab={tab} />
          ) : tab.resourceType === 'event' ? (
            <EventDetail tab={tab} />
          ) : (
            <p>此内容暂不可用。</p>
          )
        }
        renderChat={(tab) =>
          tab.chatPurpose ? <HubConversation tab={tab} /> : null
        }
        renderDocument={(id) => {
          const node = context.nodes.find(
            (item) => item.id === id && !item.deletedAt,
          );
          if (!node)
            return <p role="status">这份文档已不可用，请选择其他文档。</p>;
          const previewContext = {
            ...value,
            workbench: undefined,
            router: {
              ...context.router,
              navigate(path: string, options?: { replace?: boolean }) {
                const route = parseSpaceRoute(path);
                if (
                  route.view === 'doc' &&
                  route.id &&
                  context.nodes.some((item) => item.id === route.id)
                )
                  openDocument(route.id);
                else context.router.navigate(path, options);
              },
            },
          };
          return (
            <SpaceContext.Provider value={previewContext}>
              <DocumentView key={node.id} node={node} />
            </SpaceContext.Provider>
          );
        }}
      >
        {children}
      </WorkbenchFrame>
      {searchOpen ? (
        <SearchPanel
          open
          onClose={() => setSearchOpen(false)}
          onSelectDocument={openDocument}
        />
      ) : null}
    </SpaceContext.Provider>
  );
}
