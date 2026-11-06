import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ChevronDown,
  LoaderCircle,
  Columns2,
  ExternalLink,
  FileText,
  Files,
  Folder,
  Globe,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  RotateCw,
  Terminal,
  X,
} from 'lucide-react';
import {
  Button,
  Dialog,
  IconButton,
  Input,
  Textarea,
  Menu,
  PanelResizer,
} from '@alter/ui-system';
import type { TerminalService } from '@alter/protocol';
import { TerminalView } from './TerminalView';
import type { WorkbenchService } from '@alter/mock-workbench';
import { WorkbenchController, type TabKind, type WorkbenchTab } from './store';
import { FileView } from './files';
import { useWorkbench, useWorkbenchLayout } from './useWorkbench';
import styles from './Workbench.module.css';

export interface WorkbenchProps {
  controller: WorkbenchController;
  service: WorkbenchService;
  terminal: TerminalService;
  scopeKey: string;
  directories: string[];
  contextTitle: string;
  children: ReactNode;
  renderDocument: (id: string) => ReactNode;
  renderResource?: (tab: WorkbenchTab) => ReactNode;
  renderChat?: (tab: WorkbenchTab) => ReactNode;
  onSearchDocument: () => void;
  onDropDocument: (id: string) => void;
}
export function WorkbenchToggle({
  controller,
  scopeKey,
  hideWhenOpen = false,
}: {
  controller: WorkbenchController;
  scopeKey: string;
  hideWhenOpen?: boolean;
}) {
  const scope = useWorkbench(controller, scopeKey);
  if (hideWhenOpen && scope.open) return null;
  return (
    <IconButton
      label={scope.open ? '关闭 Workbench' : '打开 Workbench'}
      icon={<Columns2 size={17} />}
      aria-expanded={scope.open}
      onClick={() => controller.toggle(scopeKey)}
    />
  );
}
const icons = {
  start: Globe,
  web: Globe,
  chat: MessageSquare,
  terminal: Terminal,
  files: Files,
  document: FileText,
  resource: FileText,
};

export function WorkbenchFrame(props: WorkbenchProps) {
  const {
    controller,
    scopeKey,
    directories,
    contextTitle,
    service,
    terminal,
    children,
    renderDocument,
    onSearchDocument,
    onDropDocument,
  } = props;
  const scope = useWorkbench(controller, scopeKey);
  const {
    layoutRef,
    compact,
    width,
    panelWidth,
    maxWidth,
    resize,
    resetWidth,
  } = useWorkbenchLayout();
  const panelRef = useRef<HTMLElement>(null);
  const [tabMenu, setTabMenu] = useState<HTMLElement | null>(null);
  const [closeError, setCloseError] = useState('');
  const [savingClose, setSavingClose] = useState(false);
  const [directoryPicker, setDirectoryPicker] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [closing, setClosing] = useState<WorkbenchTab | null>(null);
  useEffect(() => {
    function start(event: DragEvent) {
      if (event.dataTransfer?.types.includes('application/x-alter-document'))
        setDropActive(true);
    }
    function end() {
      setDropActive(false);
    }
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);
  const [terminalCloseError, setTerminalCloseError] = useState('');
  async function closeTab(tab: WorkbenchTab) {
    if (tab.kind === 'terminal') {
      try {
        await terminal.close(tab.id);
      } catch {
        setTerminalCloseError('终端未能关闭，请重试。');
        return;
      }
      setTerminalCloseError('');
    }
    if (
      tab.kind === 'files' &&
      tab.fileDraft !== undefined &&
      tab.fileDraft !== tab.fileOriginal
    )
      setClosing(tab);
    else finishClose(tab.id);
  }
  function finishClose(id: string) {
    controller.close(scopeKey, id);
    requestAnimationFrame(() => {
      const activeId = controller.getScope(scopeKey).activeId;
      if (activeId) document.getElementById(`wb-tab-${activeId}`)?.focus();
      else
        layoutRef.current
          ?.querySelector<HTMLButtonElement>('[aria-label="打开 Workbench"]')
          ?.focus();
    });
  }
  function create(kind: TabKind) {
    if (kind === 'terminal') {
      if (directories.length !== 1) {
        setDirectoryPicker(true);
        return;
      }
      controller.launch(scopeKey, kind, { directory: directories[0] });
    } else if (kind === 'start') controller.add(scopeKey, kind);
    else controller.launch(scopeKey, kind);
  }
  const tabListRef = useRef<HTMLDivElement>(null);
  const previousTabs = useRef(new Set<string>());
  useEffect(() => {
    const active = scope.tabs.find((tab) => tab.id === scope.activeId);
    if (scope.open && active && !previousTabs.current.has(active.id)) {
      requestAnimationFrame(() =>
        document
          .getElementById(`wb-panel-${active.id}`)
          ?.querySelector<HTMLInputElement>('input, textarea')
          ?.focus(),
      );
    }
    previousTabs.current = new Set(scope.tabs.map((tab) => tab.id));
  }, [scope.tabs, scope.activeId, scope.open]);
  useEffect(() => {
    tabListRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [scope.activeId, width, panelWidth, scope.expanded, scope.open]);
  return (
    <div
      ref={layoutRef}
      className={styles.layout}
      data-compact={compact || undefined}
      data-open={scope.open || undefined}
      data-expanded={scope.expanded || undefined}
    >
      <div
        className={styles.primary}
        data-collapsed={
          (scope.open && (scope.expanded || compact)) || undefined
        }
      >
        {children}
      </div>
      {scope.open && !scope.expanded && !compact ? (
        <PanelResizer
          panelRef={panelRef}
          label="调整 Workbench 宽度"
          edge="left"
          min={280}
          max={maxWidth}
          onResize={resize}
          onReset={resetWidth}
        />
      ) : null}
      <aside
        ref={panelRef}
        aria-label="Workbench"
        className={styles.panel}
        style={{
          width: !scope.open
            ? 0
            : scope.expanded || compact
              ? '100%'
              : panelWidth,
        }}
        inert={!scope.open}
        data-drop={dropActive || undefined}
        onDragOver={(event) => {
          if (
            event.dataTransfer.types.includes('application/x-alter-document')
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDropActive(true);
          }
        }}
        onDrop={(event) => {
          setDropActive(false);
          const id = event.dataTransfer.getData('application/x-alter-document');
          if (id) {
            event.preventDefault();
            event.stopPropagation();
            onDropDocument(id);
          }
        }}
      >
        <header className={styles.header}>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label="Workbench 标签页"
            ref={tabListRef}
          >
            {scope.tabs.map((tab, index) => {
              const Icon = icons[tab.kind];
              return (
                <div
                  className={styles.tab}
                  key={tab.id}
                  data-active={tab.id === scope.activeId || undefined}
                >
                  <Button
                    role="tab"
                    variant="ghost"
                    id={`wb-tab-${tab.id}`}
                    aria-controls={`wb-panel-${tab.id}`}
                    aria-selected={tab.id === scope.activeId}
                    tabIndex={tab.id === scope.activeId ? 0 : -1}
                    className={styles.tabSelect}
                    title={tab.title}
                    onClick={() => controller.select(scopeKey, tab.id)}
                    onKeyDown={(event) => {
                      if (
                        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                          event.key,
                        )
                      ) {
                        event.preventDefault();
                        const target =
                          event.key === 'Home'
                            ? scope.tabs[0]
                            : event.key === 'End'
                              ? scope.tabs.at(-1)
                              : scope.tabs[
                                  (index +
                                    (event.key === 'ArrowRight' ? 1 : -1) +
                                    scope.tabs.length) %
                                    scope.tabs.length
                                ];
                        if (target) {
                          controller.select(scopeKey, target.id);
                          document
                            .getElementById(`wb-tab-${target.id}`)
                            ?.focus();
                        }
                      }
                      if (event.key === 'Delete') closeTab(tab);
                    }}
                  >
                    <Icon size={14} />
                    <span>{tab.title}</span>
                    {tab.kind === 'files' &&
                    tab.fileDraft !== tab.fileOriginal ? (
                      <span className={styles.dirtyDot} aria-label="未保存" />
                    ) : null}
                  </Button>
                  <IconButton
                    className={styles.tabClose}
                    label={`关闭标签页 ${tab.title}`}
                    size="sm"
                    icon={<X size={12} />}
                    onClick={() => closeTab(tab)}
                  />
                </div>
              );
            })}
            <IconButton
              className={styles.addTab}
              label="新建标签页"
              icon={<Plus size={16} />}
              onClick={() => create('start')}
            />
          </div>
          {scope.tabs.length > 1 ? (
            <IconButton
              label="所有标签页"
              aria-haspopup="menu"
              aria-expanded={Boolean(tabMenu)}
              icon={<ChevronDown size={15} />}
              onClick={(event) => setTabMenu(event.currentTarget)}
            />
          ) : null}

          <div className={styles.windowActions}>
            {!compact ? (
              <IconButton
                label={scope.expanded ? '收起 Workbench' : '展开 Workbench'}
                icon={
                  scope.expanded ? (
                    <Minimize2 size={16} />
                  ) : (
                    <Maximize2 size={16} />
                  )
                }
                onClick={() => controller.expand(scopeKey)}
              />
            ) : null}
            <WorkbenchToggle controller={controller} scopeKey={scopeKey} />
          </div>
        </header>
        {terminalCloseError ? (
          <p className={styles.error} role="alert">
            {terminalCloseError}
          </p>
        ) : null}
        {scope.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`wb-panel-${tab.id}`}
            aria-labelledby={`wb-tab-${tab.id}`}
            hidden={tab.id !== scope.activeId}
            className={styles.tabPanel}
          >
            {tab.kind === 'start' || tab.kind === 'web' ? (
              <BrowserTab
                key={`${tab.id}:${tab.url ?? ''}`}
                controller={controller}
                scopeKey={scopeKey}
                tab={tab}
                onCreate={create}
                onSearch={onSearchDocument}
              />
            ) : null}
            {tab.kind === 'chat'
              ? (props.renderChat?.(tab) ?? (
                  <ChatView
                    service={service}
                    controller={controller}
                    scopeKey={scopeKey}
                    tab={tab}
                    contextTitle={contextTitle}
                  />
                ))
              : null}
            {tab.kind === 'terminal' ? (
              <TerminalView
                service={terminal}
                tab={tab}
                active={scope.open && scope.activeId === tab.id}
              />
            ) : null}
            {tab.kind === 'files' ? (
              <FileView
                service={service}
                controller={controller}
                scopeKey={scopeKey}
                tab={tab}
                directories={directories}
              />
            ) : null}
            {tab.kind === 'resource' ? props.renderResource?.(tab) : null}
            {tab.kind === 'document' && tab.documentId
              ? renderDocument(tab.documentId)
              : null}
          </div>
        ))}
        {dropActive ? (
          <div className={styles.dropHint}>松开以在 Workbench 中打开文档</div>
        ) : null}
      </aside>
      <Menu
        anchor={tabMenu}
        open={Boolean(tabMenu)}
        onClose={() => setTabMenu(null)}
        align="end"
        width={260}
        heading="标签页"
        actions={scope.tabs.map((tab) => {
          const Icon = icons[tab.kind];
          return {
            id: tab.id,
            label: tab.title,
            icon: <Icon size={15} />,
            active: tab.id === scope.activeId,
            onSelect: () => {
              controller.select(scopeKey, tab.id);
              setTabMenu(null);
              requestAnimationFrame(() =>
                document.getElementById(`wb-tab-${tab.id}`)?.focus(),
              );
            },
          };
        })}
      />
      <Dialog
        title="关闭未保存的文件？"
        open={Boolean(closing)}
        onClose={() => {
          if (!savingClose) {
            setClosing(null);
            setCloseError('');
          }
        }}
        size="small"
        footer={
          <>
            <Button
              disabled={savingClose}
              onClick={() => {
                setClosing(null);
                setCloseError('');
              }}
            >
              继续编辑
            </Button>
            <Button
              disabled={savingClose}
              onClick={() => {
                if (closing) finishClose(closing.id);
                setClosing(null);
              }}
            >
              放弃修改并关闭
            </Button>
            <Button
              variant="primary"
              disabled={savingClose}
              onClick={async () => {
                if (!closing?.fileRoot || !closing.filePath) return;
                setSavingClose(true);
                setCloseError('');
                try {
                  await service.saveFile(
                    closing.fileRoot,
                    closing.filePath,
                    closing.fileDraft ?? '',
                  );
                  finishClose(closing.id);
                  setClosing(null);
                } catch {
                  setCloseError('保存失败，请重试。修改仍保留在标签页中。');
                } finally {
                  setSavingClose(false);
                }
              }}
            >
              {savingClose ? '正在保存…' : '保存并关闭'}
            </Button>
          </>
        }
      >
        <p>文件的修改尚未保存，关闭后会丢失这些修改。</p>
        {closeError ? (
          <p role="alert" className={styles.error}>
            {closeError}
          </p>
        ) : null}
      </Dialog>
      <Dialog
        title="选择终端工作目录"
        open={directoryPicker}
        onClose={() => setDirectoryPicker(false)}
        size="small"
      >
        {directories.length ? (
          <div className={styles.directoryChoices}>
            {directories.map((directory) => (
              <Button
                key={directory}
                variant="ghost"
                onClick={() => {
                  controller.launch(scopeKey, 'terminal', { directory });
                  setDirectoryPicker(false);
                }}
              >
                <Folder size={16} />
                <span>{directory}</span>
                <ChevronRight size={14} />
              </Button>
            ))}
          </div>
        ) : (
          <p className={styles.emptyText}>
            当前空间还没有工作目录。请先在空间配置中添加。
          </p>
        )}
      </Dialog>
    </div>
  );
}

function BrowserTab({
  controller,
  scopeKey,
  tab,
  onCreate,
  onSearch,
}: {
  controller: WorkbenchController;
  scopeKey: string;
  tab: WorkbenchTab;
  onCreate: (kind: TabKind) => void;
  onSearch: () => void;
}) {
  const [address, setAddress] = useState(tab.url ?? '');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(Boolean(tab.url));
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const timeout = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [loading, tab.url, reload]);
  const entries = [
    {
      kind: 'chat',
      title: '侧边聊天',
      icon: MessageSquare,
    },
    { kind: 'terminal', title: '终端', icon: Terminal },
    {
      kind: 'document',
      title: '打开页面',
      icon: FileText,
    },
    { kind: 'files', title: '文件', icon: Files },
  ] as const;
  return (
    <div
      className={tab.kind === 'start' ? styles.startPage : styles.browserPage}
    >
      <form
        className={styles.addressBar}
        onSubmit={(event) => {
          event.preventDefault();
          try {
            controller.navigate(scopeKey, tab.id, address);
            setError('');
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : '地址无效，请检查后重试',
            );
          }
        }}
      >
        {tab.kind === 'web' ? (
          <>
            <IconButton
              label="后退"
              size="sm"
              disabled={!tab.historyIndex}
              icon={<ArrowLeft size={15} />}
              onClick={() => controller.travel(scopeKey, tab.id, -1)}
            />
            <IconButton
              label="前进"
              size="sm"
              disabled={
                (tab.historyIndex ?? 0) >= (tab.history?.length ?? 0) - 1
              }
              icon={<ArrowRight size={15} />}
              onClick={() => controller.travel(scopeKey, tab.id, 1)}
            />
            <IconButton
              label="刷新网页"
              size="sm"
              icon={<RotateCw size={15} />}
              onClick={() => {
                setLoading(true);
                setSlow(false);
                setReload((value) => value + 1);
              }}
            />
          </>
        ) : (
          <Globe size={16} aria-hidden="true" />
        )}
        <Input
          aria-label="网页地址"
          value={address}
          placeholder="输入网址"
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          aria-describedby={error ? `address-error-${tab.id}` : undefined}
          onChange={(event) => {
            setAddress(event.target.value);
            setError('');
          }}
          invalid={Boolean(error)}
        />
        <IconButton
          label="打开网页"
          disabled={!address.trim()}
          type="submit"
          size="sm"
          icon={<ArrowRight size={16} />}
        />
        {tab.url ? (
          <IconButton
            label="在默认浏览器中打开"
            size="sm"
            icon={<ExternalLink size={15} />}
            onClick={() =>
              window.open(tab.url, '_blank', 'noopener,noreferrer')
            }
          />
        ) : null}
      </form>
      {error ? (
        <p id={`address-error-${tab.id}`} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {tab.kind === 'start' ? (
        <div className={styles.start}>
          <div className={styles.launcher}>
            {entries.map((entry) => (
              <Button
                key={entry.kind}
                className={styles.launcherRow}
                variant="ghost"
                onClick={() =>
                  entry.kind === 'document' ? onSearch() : onCreate(entry.kind)
                }
              >
                <entry.icon size={20} strokeWidth={1.5} />
                <span>
                  <strong>{entry.title}</strong>
                </span>
                <ChevronRight className={styles.launcherArrow} size={15} />
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.browser}>
          <div className={styles.browserStatus} role="status">
            <span>
              {loading
                ? '正在打开网页…'
                : '部分网站不支持内嵌浏览，可在外部打开'}
              {slow ? ' 若网页未显示，请在默认浏览器中打开。' : ''}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                window.open(tab.url, '_blank', 'noopener,noreferrer')
              }
            >
              外部打开
              <ExternalLink size={13} />
            </Button>
          </div>
          <iframe
            key={`${tab.url}-${reload}`}
            title={`网页预览 ${tab.title}`}
            src={tab.url}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setSlow(true);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function ChatView({
  service,
  controller,
  scopeKey,
  tab,
  contextTitle,
}: {
  service: WorkbenchService;
  controller: WorkbenchController;
  scopeKey: string;
  tab: WorkbenchTab;
  contextTitle: string;
}) {
  const [messages, setMessages] = useState(() => service.messages(tab.id));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const draft = tab.draft ?? '';
  useEffect(() => {
    if (messagesRef.current)
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages.length, sending]);
  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(200, Math.max(68, input.scrollHeight))}px`;
  }, [draft]);
  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setError('');
    controller.update(scopeKey, tab.id, { draft: '' });
    const pending = service.sendMessage(tab.id, draft.trim(), contextTitle);
    setMessages(service.messages(tab.id));
    try {
      await pending;
      setMessages(service.messages(tab.id));
    } catch {
      setError('消息未发送成功，请重试');
      controller.update(scopeKey, tab.id, { draft });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }
  return (
    <div className={styles.chat}>
      <div className={styles.context}>
        <FileText size={14} />
        <span>{contextTitle || '当前空间'}</span>
      </div>
      <div
        ref={messagesRef}
        className={styles.messages}
        role="log"
        aria-label="讨论记录"
      >
        {!messages.length ? (
          <div className={styles.chatEmpty}>
            <MessageSquare size={26} strokeWidth={1.3} />
            <h2>从这里继续思考</h2>
            <p>写下问题、想法，或需要一起梳理的线索。</p>
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={styles.message}
              data-role={message.role}
            >
              <span>{message.role === 'user' ? '我' : 'Alter'}</span>
              <p>{message.content}</p>
            </article>
          ))
        )}
        {sending ? (
          <p role="status" className={styles.emptyText}>
            正在思考…
          </p>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          ref={composerRef}
          aria-label="讨论内容"
          placeholder="聊聊你的想法…"
          value={draft}
          onChange={(event) =>
            controller.update(scopeKey, tab.id, { draft: event.target.value })
          }
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div>
          <span>Enter 发送 · Shift Enter 换行</span>
          <IconButton
            className={styles.sendButton}
            label="发送消息"
            type="submit"
            disabled={!draft.trim() || sending}
            icon={
              sending ? (
                <LoaderCircle size={17} className={styles.spinner} />
              ) : (
                <ArrowUp size={17} />
              )
            }
          />
        </div>
      </form>
    </div>
  );
}
