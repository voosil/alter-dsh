import { useId, useState } from 'react';
import { Archive, Check, Plus, Trash2 } from 'lucide-react';
import { useSpaceContext } from '../runtime';
import { DirectoryField } from '../components/DirectoryField';
import { CreateAgentDialog } from '../components/CreateAgentDialog';
import { SpaceAppearanceField } from '../components/SpaceAppearanceField';
import { DecisionPolicy, SpacePlugins } from '../hub/SpaceSettings';
import { Button, Dialog, Field, Input, Textarea } from '@alter/ui-system';
import { SpaceDetailShell } from './SpaceDetailShell';
import styles from './ConfigView.module.css';

function sameSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((item, index) => item === right[index]);
}

export function ConfigView() {
  const {
    service,
    router,
    space,
    spaceId,
    spaces,
    agents,
    refresh,
    toast,
    removeSpaceFromState,
  } = useSpaceContext();
  const [name, setName] = useState(space.name);
  const [goal, setGoal] = useState(space.goal);
  const [directories, setDirectories] = useState<string[]>(space.directories);
  const [collaborators, setCollaborators] = useState<string[]>(
    space.collaboratorIds,
  );
  const [icon, setIcon] = useState(space.icon ?? 'layers');
  const [color, setColor] = useState(space.color ?? '#4c4e53');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nameId = useId();
  const goalId = useId();
  const deleteConfirmId = useId();
  const deleteConfirmed = deleteConfirm.trim() === space.name.trim();

  function openDelete() {
    setDeleteConfirm('');
    setDeleteOpen(true);
  }

  function closeDelete() {
    setDeleteConfirm('');
    setDeleteOpen(false);
  }

  const dirty =
    name !== space.name ||
    goal !== space.goal ||
    icon !== (space.icon ?? 'layers') ||
    color !== (space.color ?? '#4c4e53') ||
    !sameSet(directories, space.directories) ||
    !sameSet(collaborators, space.collaboratorIds);

  function toggleCollaborator(id: string) {
    setCollaborators((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  function reset() {
    setName(space.name);
    setGoal(space.goal);
    setIcon(space.icon ?? 'layers');
    setColor(space.color ?? '#4c4e53');
    setDirectories(space.directories);
    setCollaborators(space.collaboratorIds);
    setError('');
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('填写空间名称');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await service.updateSpace(spaceId, {
        name: trimmed,
        goal,
        icon,
        color,
        directories,
        collaboratorIds: collaborators,
      });
      setName(trimmed);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function archiveCurrentSpace() {
    setArchiving(true);
    setError('');
    try {
      const fallback = spaces.find((item) => item.id !== spaceId);
      await service.archiveSpace(spaceId);
      removeSpaceFromState(spaceId);
      setArchiveOpen(false);
      refresh();
      toast('空间已归档');
      router.navigate(fallback ? `#/space/${fallback.id}` : '#/space');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档失败，请重试');
      setArchiveOpen(false);
    } finally {
      setArchiving(false);
    }
  }

  async function removeSpace() {
    setDeleting(true);
    try {
      const fallback = spaces.find((item) => item.id !== spaceId);
      await service.deleteSpace(spaceId);
      removeSpaceFromState(spaceId);
      closeDelete();
      refresh();
      toast('空间已删除');
      router.navigate(fallback ? `#/space/${fallback.id}` : '#/space');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败，请重试');
      closeDelete();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <SpaceDetailShell active="config">
      <div className={styles.form}>
        <section className={styles.section} aria-labelledby="basic-title">
          <div className={styles.sectionIntro}>
            <h2 id="basic-title" className={styles.sectionTitle}>
              基本信息
            </h2>
          </div>
          <div className={styles.sectionBody}>
            <div className={styles.fields}>
              <Field label="空间名称" htmlFor={nameId}>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="长期目标" htmlFor={goalId}>
                <Textarea
                  id={goalId}
                  value={goal}
                  rows={3}
                  placeholder="这个空间要长期推进什么？"
                  onChange={(event) => setGoal(event.target.value)}
                />
              </Field>
              <SpaceAppearanceField
                icon={icon}
                color={color}
                label="外观"
                onIconChange={setIcon}
                onColorChange={setColor}
              />
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="dirs-title">
          <div className={styles.sectionIntro}>
            <h2 id="dirs-title" className={styles.sectionTitle}>
              工作目录
            </h2>
          </div>
          <div className={styles.sectionBody}>
            <DirectoryField
              directories={directories}
              onChange={setDirectories}
            />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="agents-title">
          <div className={styles.sectionIntro}>
            <h2 id="agents-title" className={styles.sectionTitle}>
              协作者
            </h2>
            <Button
              size="sm"
              variant="secondary"
              className={styles.introAction}
              onClick={() => setCreateAgentOpen(true)}
            >
              <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
              新建协作者
            </Button>
          </div>
          <div className={styles.sectionBody}>
            {agents.length ? (
              <ul className={styles.optionList}>
                {agents.map((agent) => {
                  const selected = collaborators.includes(agent.id);
                  return (
                    <li key={agent.id}>
                      <button
                        type="button"
                        className={styles.collaborator}
                        data-selected={selected || undefined}
                        aria-pressed={selected}
                        onClick={() => toggleCollaborator(agent.id)}
                      >
                        <span className={styles.avatar} aria-hidden="true">
                          {agent.name.slice(0, 1)}
                        </span>
                        <span className={styles.optionText}>
                          <span>{agent.name}</span>
                          <span className={styles.optionMeta}>
                            {[agent.role || '未填写职责', agent.model]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        <span className={styles.check} aria-hidden="true">
                          {selected ? <Check size={11} strokeWidth={2} /> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.note}>还没有 AI 协作者。</p>
            )}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="policy-title">
          <div className={styles.sectionIntro}>
            <h2 id="policy-title" className={styles.sectionTitle}>
              Agent 的决定权限
            </h2>
          </div>
          <div className={styles.sectionBody}>
            <DecisionPolicy />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="plugins-title">
          <div className={styles.sectionIntro}>
            <h2 id="plugins-title" className={styles.sectionTitle}>
              空间插件
            </h2>
          </div>
          <div className={styles.sectionBody}>
            <SpacePlugins />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="manage-title">
          <div className={styles.sectionIntro}>
            <h2 id="manage-title" className={styles.sectionTitle}>
              空间管理
            </h2>
          </div>
          <div className={styles.sectionBody}>
            <div className={styles.management}>
              {space.isDefault ? null : (
                <div className={styles.managementRow}>
                  <span className={styles.managementLabel}>归档空间</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <Archive size={13} strokeWidth={1.7} aria-hidden="true" />
                    归档
                  </Button>
                </div>
              )}
              <div className={styles.managementRow}>
                <span className={styles.managementLabel}>删除空间</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={space.isDefault}
                  onClick={openDelete}
                >
                  <Trash2 size={13} strokeWidth={1.7} aria-hidden="true" />
                  删除
                </Button>
              </div>
            </div>
            {space.isDefault ? (
              <p className={styles.note}>默认空间不能归档或删除。</p>
            ) : null}
          </div>
        </section>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className={styles.saveBar} data-dirty={dirty || undefined}>
        <span className={styles.saveNote}>
          {dirty ? '有未保存的更改' : '已保存'}
        </span>
        <div className={styles.saveActions}>
          {dirty ? (
            <Button size="sm" variant="secondary" onClick={reset}>
              取消
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={dirty ? 'primary' : 'secondary'}
            className={dirty ? undefined : styles.quietAction}
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? '正在保存…' : '保存'}
          </Button>
        </div>
      </div>

      <Dialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="归档空间？"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={() => setArchiveOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={archiving}
              onClick={() => void archiveCurrentSpace()}
            >
              {archiving ? '正在归档…' : '归档空间'}
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>
          「{space.name}
          」会从空间列表移出，内容保持不变。你可以稍后在设置中的「归档管理」恢复它。
        </p>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={closeDelete}
        title="删除空间？"
        size="small"
        footer={
          <>
            <Button variant="secondary" onClick={closeDelete}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleting || !deleteConfirmed}
              onClick={() => void removeSpace()}
            >
              {deleting ? '正在删除…' : '删除空间'}
            </Button>
          </>
        }
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            「{space.name}」中的文档、随想和记录会一起删除，无法在应用内撤销。
            删除前会先自动做一份备份；如果备份失败，删除会被取消。
          </p>
          <Field label="输入空间名称以确认" htmlFor={deleteConfirmId}>
            <Input
              id={deleteConfirmId}
              value={deleteConfirm}
              autoComplete="off"
              onChange={(event) => setDeleteConfirm(event.target.value)}
            />
          </Field>
        </div>
      </Dialog>

      <CreateAgentDialog
        open={createAgentOpen}
        onClose={() => setCreateAgentOpen(false)}
        onCreated={(agent) => {
          setCreateAgentOpen(false);
          setCollaborators((current) =>
            current.includes(agent.id) ? current : [...current, agent.id],
          );
          refresh();
          toast('已创建协作者');
        }}
      />
    </SpaceDetailShell>
  );
}
