export interface SpaceRouter {
  getPath(): string;
  subscribe(listener: () => void): () => void;
  navigate(path: string, options?: { replace?: boolean }): void;
}

export interface SpaceCapabilities {
  hubRegistry?: import('./hub/registry').SpaceHubRegistry;
  service: import('@alter/protocol').SpaceService;
  router: SpaceRouter;
  workbench?: {
    controller: import('@alter/ui-workbench').WorkbenchController;
    service: import('@alter/mock-workbench').WorkbenchService;
    terminal: import('@alter/protocol').TerminalService;
  };
}
