import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  Bot,
  Command,
  Globe,
  Info,
} from 'lucide-react';
import type { Agent, Space, SpaceService } from '@alter/protocol';
import { Button, Field, Input } from '@alter/ui-system';
import type { WorkbenchController } from '@alter/ui-workbench';
import styles from './SettingsPage.module.css';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
  }).format(new Date(value));
}

function formatArchivedAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export interface SettingsCapabilities {
  service: SpaceService;
  workbench?: WorkbenchController;
}

export function SettingsPage({ service, workbench }: SettingsCapabilities) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [archivedSpaces, setArchivedSpaces] = useState<Space[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const nameId = useId();
  const roleId = useId();

  useEffect(() => {
    let active = true;
    void Promise.all([service.listAgents(), service.listArchivedSpaces()]).then(
      ([nextAgents, nextArchivedSpaces]) => {
        if (!active) return;
        setAgents(nextAgents);
        setArchivedSpaces(nextArchivedSpaces);
        setLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, [service]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('填写协作者名称');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const agent = await service.createAgent({ name, role });
      setAgents((items) => [...items, agent]);
      setName('');
      setRole('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function restoreSpace(space: Space) {
    setRestoring(space.id);
    setError('');
    setNotice('');
    try {
      await service.unarchiveSpace(space.id);
      setArchivedSpaces((items) =>
        items.filter((item) => item.id !== space.id),
      );
      setNotice(`已恢复「${space.name}」`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复失败，请重试');
    } finally {
      setRestoring(null);
    }
  }

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  }

  return (
    <section className={styles.page} aria-label="设置">
      <header className={styles.toolbar}>设置</header>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="设置项">
          <span className={styles.navTitle}>设置项</span>
          <button
            type="button"
            className={styles.navItem}
            onClick={() => jumpTo('settings-agents')}
          >
            <Bot size={15} strokeWidth={1.6} aria-hidden="true" />
            AI 协作者
          </button>
          <button
            type="button"
            className={styles.navItem}
            aria-label="归档管理"
            onClick={() => jumpTo('settings-archive')}
          >
            <Archive size={15} strokeWidth={1.6} aria-hidden="true" />
            归档管理
            {loaded && archivedSpaces.length ? (
              <span className={styles.navCount} aria-hidden="true">
                {archivedSpaces.length}
              </span>
            ) : null}
          </button>
          {workbench ? (
            <button
              type="button"
              className={styles.navItem}
              onClick={() => jumpTo('settings-links')}
            >
              <Globe size={15} strokeWidth={1.6} aria-hidden="true" />
              网页链接
            </button>
          ) : null}
          <button
            type="button"
            className={styles.navItem}
            onClick={() => jumpTo('settings-shortcuts')}
          >
            <Command size={15} strokeWidth={1.6} aria-hidden="true" />
            快捷键
          </button>
          <button
            type="button"
            className={styles.navItem}
            onClick={() => jumpTo('settings-about')}
          >
            <Info size={15} strokeWidth={1.6} aria-hidden="true" />
            关于
          </button>
        </nav>

        <div className={styles.content}>
          {notice ? (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className={styles.errorBanner} role="alert">
              {error}
            </p>
          ) : null}

          <section
            id="settings-agents"
            className={styles.section}
            aria-labelledby="agents-title"
          >
            <div className={styles.sectionHead}>
              <h2 id="agents-title" className={styles.sectionTitle}>
                AI 协作者
              </h2>
              <p className={styles.sectionNote}>
                空间配置中可以选择这些协作者。每个协作者拥有自己的名称与职责。
              </p>
            </div>
            <div className={styles.agentList}>
              {agents.map((agent) => (
                <div className={styles.agentRow} key={agent.id}>
                  <span className={styles.avatar} aria-hidden="true">
                    {agent.name.slice(0, 1)}
                  </span>
                  <div className={styles.agentText}>
                    <span className={styles.agentName}>{agent.name}</span>
                    <span className={styles.agentRole}>
                      {agent.role || '未填写职责'}
                    </span>
                  </div>
                  <span className={styles.agentDate}>
                    {formatDate(agent.createdAt)} 创建
                  </span>
                </div>
              ))}
            </div>
            <form className={styles.agentForm} onSubmit={handleSubmit}>
              <div className={styles.fields}>
                <Field label="名称" htmlFor={nameId}>
                  <Input
                    id={nameId}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：研究助手"
                  />
                </Field>
                <Field label="职责" htmlFor={roleId}>
                  <Input
                    id={roleId}
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                    placeholder="例如：资料检索与事实核对"
                  />
                </Field>
              </div>
              <div className={styles.formFoot}>
                <span className={styles.hint}>
                  创建后可在空间配置中邀请协作者。
                </span>
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? '正在创建…' : '创建协作者'}
                </Button>
              </div>
            </form>
          </section>

          <section
            id="settings-archive"
            className={styles.section}
            aria-labelledby="archive-title"
          >
            <div className={styles.sectionHead}>
              <h2 id="archive-title" className={styles.sectionTitle}>
                归档管理
              </h2>
              <p className={styles.sectionNote}>
                已归档空间不会出现在空间选择器中。恢复后会回到空间列表末尾。
              </p>
            </div>
            {!loaded ? (
              <p className={styles.empty} role="status">
                正在读取归档空间…
              </p>
            ) : archivedSpaces.length ? (
              <div className={styles.archiveList}>
                {archivedSpaces.map((space) => (
                  <div className={styles.archiveRow} key={space.id}>
                    <span className={styles.archiveIcon} aria-hidden="true">
                      <Archive size={16} strokeWidth={1.5} />
                    </span>
                    <div className={styles.archiveText}>
                      <span className={styles.archiveName}>{space.name}</span>
                      <span className={styles.archiveGoal}>
                        {space.goal || '未填写长期目标'}
                      </span>
                      <span className={styles.archiveDate}>
                        {space.archivedAt
                          ? `${formatArchivedAt(space.archivedAt)} 归档`
                          : '已归档'}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={restoring === space.id}
                      onClick={() => void restoreSpace(space)}
                    >
                      <ArchiveRestore
                        size={13}
                        strokeWidth={1.7}
                        aria-hidden="true"
                      />
                      {restoring === space.id ? '正在恢复…' : '恢复空间'}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>
                还没有归档空间。归档后的空间会保留在这里，直到恢复。
              </p>
            )}
          </section>

          {workbench ? <LinkPreference controller={workbench} /> : null}
          <section
            id="settings-shortcuts"
            className={styles.section}
            aria-labelledby="shortcuts-title"
          >
            <div className={styles.sectionHead}>
              <h2 id="shortcuts-title" className={styles.sectionTitle}>
                快捷键
              </h2>
            </div>
            <dl className={styles.shortcuts}>
              <div className={styles.shortcutRow}>
                <dt>记录一条随想</dt>
                <dd>
                  <kbd>⌘</kbd>
                  <kbd>E</kbd>
                </dd>
              </div>
              <div className={styles.shortcutRow}>
                <dt>搜索当前空间</dt>
                <dd>
                  <kbd>⌘</kbd>
                  <kbd>K</kbd>
                </dd>
              </div>
            </dl>
          </section>

          <section
            id="settings-about"
            className={styles.section}
            aria-labelledby="about-title"
          >
            <div className={styles.sectionHead}>
              <h2 id="about-title" className={styles.sectionTitle}>
                关于
              </h2>
            </div>
            <div className={styles.about}>
              <span>Alter 0.1.0</span>
              <span className={styles.aboutNote}>
                本地优先，数据保存在这台设备。
              </span>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function LinkPreference({ controller }: { controller: WorkbenchController }) {
  const external = useSyncExternalStore(
    controller.subscribe,
    controller.getExternalLinks,
  );
  return (
    <section
      className={styles.section}
      aria-labelledby="links-title"
      id="settings-links"
    >
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id="links-title">
          网页链接
        </h2>
        <p className={styles.sectionNote}>
          选择点击文档中的网页链接后在哪里打开。
        </p>
      </div>
      <div role="group" aria-label="网页链接打开方式">
        <Button
          aria-pressed={!external}
          variant={!external ? 'primary' : 'secondary'}
          onClick={() => controller.setExternalLinks(false)}
        >
          在 Workbench 中打开
        </Button>
        <Button
          aria-pressed={external}
          variant={external ? 'primary' : 'secondary'}
          onClick={() => controller.setExternalLinks(true)}
        >
          在默认浏览器中打开
        </Button>
      </div>
    </section>
  );
}
