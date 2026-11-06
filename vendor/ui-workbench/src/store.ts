export type TabKind =
  | 'start'
  | 'web'
  | 'chat'
  | 'terminal'
  | 'files'
  | 'document'
  | 'resource';
export interface WorkbenchTab {
  id: string;
  kind: TabKind;
  title: string;
  url?: string;
  history?: string[];
  historyIndex?: number;
  directory?: string;
  documentId?: string;
  resourceId?: string;
  resourceType?: string;
  chatPurpose?: string;
  entityId?: string;
  draft?: string;
  filePath?: string;
  fileRoot?: string;
  fileDraft?: string;
  fileOriginal?: string;
}
export interface WorkbenchScope {
  open: boolean;
  expanded: boolean;
  tabs: WorkbenchTab[];
  activeId: string | null;
}
const EMPTY: WorkbenchScope = {
  open: false,
  expanded: false,
  tabs: [],
  activeId: null,
};

export function normalizeWebUrl(input: string) {
  const text = input.trim();
  if (!text) throw new Error('输入网页地址');
  const url = new URL(
    /^[a-z][a-z\d+.-]*:/i.test(text) && !/^localhost:\d/i.test(text)
      ? text
      : `${/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(text) ? 'http' : 'https'}://${text}`,
  );
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('仅支持 http 或 https 网页地址');
  return url.href;
}

/** Owned by application assembly, shared by consumers; no module-local singleton. */
export class WorkbenchController {
  private scopes = new Map<string, WorkbenchScope>();
  private listeners = new Set<() => void>();
  private externalLinks = false;
  constructor() {
    try {
      this.externalLinks =
        localStorage.getItem('alter.workbench.externalLinks') === 'true';
    } catch {
      /* Preference is best effort. */
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getScope = (key: string) => this.scopes.get(key) ?? EMPTY;
  private set(key: string, scope: WorkbenchScope) {
    this.scopes.set(key, scope);
    this.listeners.forEach((listener) => listener());
  }
  toggle(key: string) {
    const scope = this.getScope(key);
    if (!scope.tabs.length) {
      this.add(key, 'start');
      return;
    }
    this.set(key, { ...scope, open: !scope.open });
  }
  expand(key: string) {
    const scope = this.getScope(key);
    this.set(key, { ...scope, expanded: !scope.expanded });
  }
  launch(key: string, kind: TabKind, details: Partial<WorkbenchTab> = {}) {
    return this.add(key, kind, details, true);
  }
  add(
    key: string,
    kind: TabKind,
    details: Partial<WorkbenchTab> = {},
    replaceStart = false,
  ) {
    const scope = this.getScope(key);
    const titles: Record<TabKind, string> = {
      start: '新标签页',
      web: '网页',
      chat: '侧边聊天',
      terminal: '终端',
      files: '文件',
      document: '文档',
      resource: '事项',
    };
    if (kind === 'document' || kind === 'resource') {
      const existing = scope.tabs.find(
        (tab) =>
          tab.kind === kind &&
          (kind === 'document'
            ? tab.documentId === details.documentId
            : tab.resourceId === details.resourceId &&
              tab.resourceType === details.resourceType),
      );
      if (existing) {
        this.set(key, {
          ...scope,
          open: true,
          activeId: existing.id,
          tabs: replaceStart
            ? scope.tabs.filter(
                (tab) => tab.id !== scope.activeId || tab.kind !== 'start',
              )
            : scope.tabs,
        });
        return existing.id;
      }
    }
    const tab: WorkbenchTab = {
      ...details,
      id: crypto.randomUUID(),
      kind,
      title: details.title ?? titles[kind],
    };
    const startIndex = replaceStart
      ? scope.tabs.findIndex(
          (item) => item.id === scope.activeId && item.kind === 'start',
        )
      : -1;
    this.set(key, {
      ...scope,
      open: true,
      tabs:
        startIndex < 0
          ? [...scope.tabs, tab]
          : scope.tabs.map((item, index) =>
              index === startIndex ? tab : item,
            ),
      activeId: tab.id,
    });
    return tab.id;
  }
  select(key: string, id: string) {
    const scope = this.getScope(key);
    if (scope.tabs.some((tab) => tab.id === id))
      this.set(key, { ...scope, activeId: id });
  }
  close(key: string, id: string) {
    const scope = this.getScope(key);
    const index = scope.tabs.findIndex((tab) => tab.id === id);
    const tabs = scope.tabs.filter((tab) => tab.id !== id);
    this.set(key, {
      ...scope,
      tabs,
      open: tabs.length > 0,
      activeId:
        scope.activeId === id
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : scope.activeId,
    });
  }
  update(key: string, id: string, patch: Partial<WorkbenchTab>) {
    const scope = this.getScope(key);
    this.set(key, {
      ...scope,
      tabs: scope.tabs.map((tab) =>
        tab.id === id ? { ...tab, ...patch, id: tab.id } : tab,
      ),
    });
  }
  navigate(key: string, id: string, input: string) {
    const url = normalizeWebUrl(input);
    const tab = this.getScope(key).tabs.find((item) => item.id === id);
    if (!tab) return;
    const history = [
      ...(tab.history ?? []).slice(0, (tab.historyIndex ?? -1) + 1),
      url,
    ];
    this.update(key, id, {
      kind: 'web',
      url,
      title: new URL(url).host,
      history,
      historyIndex: history.length - 1,
    });
  }
  travel(key: string, id: string, offset: number) {
    const tab = this.getScope(key).tabs.find((item) => item.id === id);
    const index = (tab?.historyIndex ?? 0) + offset;
    const url = tab?.history?.[index];
    if (url)
      this.update(key, id, {
        url,
        title: new URL(url).host,
        historyIndex: index,
      });
  }
  getExternalLinks = () => this.externalLinks;
  setExternalLinks(value: boolean) {
    this.externalLinks = value;
    try {
      localStorage.setItem('alter.workbench.externalLinks', String(value));
    } catch {
      /* Preference is best effort. */
    }
    this.listeners.forEach((listener) => listener());
  }
  openLink(key: string, url: string) {
    const normalized = normalizeWebUrl(url);
    if (this.externalLinks) {
      window.open(normalized, '_blank', 'noopener,noreferrer');
      return;
    }
    const id = this.add(key, 'start');
    this.navigate(key, id, normalized);
  }
}
