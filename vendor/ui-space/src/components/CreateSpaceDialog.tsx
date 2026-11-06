import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, Folder, Users } from 'lucide-react';
import type { Space } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { DirectoryField } from './DirectoryField';
import { Button, Dialog, Field, Input, Textarea } from '@alter/ui-system';
import { SpaceAppearanceField } from './SpaceAppearanceField';
import styles from './CreateSpaceDialog.module.css';

export function CreateSpaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (space: Space) => void;
}) {
  const { service, agents, router } = useSpaceContext();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [icon, setIcon] = useState('layers');
  const [color, setColor] = useState('#4c4e53');
  const [directories, setDirectories] = useState<string[]>([]);
  const [collaborators, setCollaborators] = useState<string[]>(() =>
    agents[0] ? [agents[0].id] : [],
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const goalId = useId();

  useEffect(() => {
    const timer = window.setTimeout(() => nameRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, []);

  function toggleCollaborator(id: string) {
    setCollaborators((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('填写空间名称');
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const space = await service.createSpace({
        name,
        goal,
        directories,
        collaboratorIds: collaborators,
        icon,
        color,
      });
      onCreated(space);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请重试');
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建空间"
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-space-form"
            variant="primary"
            disabled={saving}
          >
            {saving ? '正在创建…' : '创建空间'}
          </Button>
        </>
      }
    >
      <form id="create-space-form" className={styles.form} onSubmit={submit}>
        <Field label="名称" htmlFor={nameId}>
          <Input
            ref={nameRef}
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品与行动"
          />
        </Field>
        <Field label="长期目标" htmlFor={goalId}>
          <Textarea
            id={goalId}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="这个空间要长期帮助你推进什么？"
            rows={2}
          />
        </Field>

        <SpaceAppearanceField
          icon={icon}
          color={color}
          onIconChange={setIcon}
          onColorChange={setColor}
        />

        <div className={styles.field}>
          <span className={styles.label}>
            <Folder size={13} strokeWidth={1.6} aria-hidden="true" />
            工作目录
          </span>
          <DirectoryField directories={directories} onChange={setDirectories} />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>
            <Users size={13} strokeWidth={1.6} aria-hidden="true" />
            协作者
          </span>
          {agents.length ? (
            <div className={styles.collaborators}>
              {agents.map((agent) => {
                const selected = collaborators.includes(agent.id);
                return (
                  <button
                    key={agent.id}
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
                      <span className={styles.optionMeta}>{agent.role}</span>
                    </span>
                    <span className={styles.check} aria-hidden="true">
                      {selected ? <Check size={11} strokeWidth={2} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <span className={styles.hint}>还没有 AI 协作者。</span>
          )}
          <button
            type="button"
            className={styles.settingsLink}
            onClick={() => {
              onClose();
              router.navigate('#/settings');
            }}
          >
            创建协作者
          </button>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
