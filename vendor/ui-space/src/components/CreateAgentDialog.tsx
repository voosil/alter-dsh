import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import type { Agent, AgentPermission } from '@alter/protocol';
import { useSpaceContext } from '../runtime';
import { Button, Dialog, Field, Input, Textarea } from '@alter/ui-system';
import styles from './CreateAgentDialog.module.css';

const MODEL_OPTIONS = [
  { value: '', label: '默认（跟随 DSH）' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
] as const;

const PERMISSION_OPTIONS: { value: AgentPermission; label: string }[] = [
  { value: 'read', label: '查看内容' },
  { value: 'edit', label: '编辑文档' },
  { value: 'comment', label: '评论与建议' },
  { value: 'manage', label: '管理空间' },
];

const DEFAULT_PERMISSIONS: AgentPermission[] = ['read', 'edit', 'comment'];

/**
 * Dedicated collaborator creation dialog, opened from a space's configuration
 * page. The added fields (description / model / permissions) are product-level
 * collaborator metadata: they are persisted with the agent but do not bind a
 * DSH Agent runtime yet.
 */
export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}) {
  const { service } = useSpaceContext();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [permissions, setPermissions] = useState<AgentPermission[]>(
    DEFAULT_PERMISSIONS,
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const roleId = useId();
  const descriptionId = useId();

  // The dialog stays mounted while closed, so every open starts a fresh draft.
  useEffect(() => {
    if (!open) return;
    setName('');
    setRole('');
    setDescription('');
    setModel('');
    setPermissions(DEFAULT_PERMISSIONS);
    setError('');
    setSaving(false);
    const timer = window.setTimeout(() => nameRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [open]);

  function togglePermission(permission: AgentPermission) {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('填写协作者名称');
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const agent = await service.createAgent({
        name,
        role,
        description,
        model,
        permissions,
      });
      onCreated(agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请重试');
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建协作者"
      size="medium"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-agent-form"
            variant="primary"
            disabled={saving}
          >
            {saving ? '正在创建…' : '创建协作者'}
          </Button>
        </>
      }
    >
      <form id="create-agent-form" className={styles.form} onSubmit={submit}>
        <Field label="名称" htmlFor={nameId}>
          <Input
            ref={nameRef}
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
        <Field label="描述" htmlFor={descriptionId}>
          <Textarea
            id={descriptionId}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="介绍它擅长什么、通常如何与空间协作…"
          />
        </Field>
        <div className={styles.field}>
          <span className={styles.label}>使用的模型</span>
          <div className={styles.chips} role="group" aria-label="使用的模型">
            {MODEL_OPTIONS.map((option) => {
              const selected = model === option.value;
              return (
                <button
                  key={option.value || 'default'}
                  type="button"
                  className={styles.chip}
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  onClick={() => setModel(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>权限</span>
          <div className={styles.chips} role="group" aria-label="权限">
            {PERMISSION_OPTIONS.map((option) => {
              const selected = permissions.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={styles.chip}
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  onClick={() => togglePermission(option.value)}
                >
                  {selected ? (
                    <Check size={11} strokeWidth={2.2} aria-hidden="true" />
                  ) : null}
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <p className={styles.note}>
          创建后会加入当前空间的协作者列表，保存空间配置后生效。
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
