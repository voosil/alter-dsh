import { useState } from 'react';
import type { MatterStatus } from '@alter/protocol';
import { Button, Field, Menu, Textarea } from '@alter/ui-system';
import type { WorkbenchTab } from '@alter/ui-workbench';
import { useSpaceContext } from '../runtime';
import { useHub, useHubAction, statusLabels, dateText } from './context';
import styles from './Hub.module.css';

export function MatterDetail({ tab }: { tab: WorkbenchTab }) {
  const { service, spaceId, workbench, nodes } = useSpaceContext();
  const hub = useHub();
  const action = useHubAction();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [abandon, setAbandon] = useState(false);
  const [reason, setReason] = useState('');
  const [index, setIndex] = useState(0);
  const matter = hub.matters.find((item) => item.id === tab.resourceId);
  let answers: Record<string, string> = {};
  try {
    answers = JSON.parse(tab.draft || '{}') as Record<string, string>;
  } catch {
    /* Empty draft. */
  }
  if (!matter) return <p className={styles.empty}>事项已不可用。</p>;
  const question = matter.questions[index];
  const answered = matter.questions.filter((q) => answers[q.id]?.trim()).length;
  const ready = matter.questions.every(
    (q) => !q.required || answers[q.id]?.trim(),
  );
  function answer(value: string) {
    if (workbench && question)
      workbench.controller.update(workbench.scopeKey, tab.id, {
        draft: JSON.stringify({ ...answers, [question.id]: value }),
      });
  }
  async function setStatus(status: MatterStatus) {
    if (!matter) return;
    setAnchor(null);
    await action.run(() =>
      service.hub.setMatterStatus(spaceId, matter.id, status),
    );
  }
  return (
    <div className={styles.detail}>
      <div className={styles.actions}>
        <span className={styles.status}>{statusLabels[matter.status]}</span>
        <Button
          size="sm"
          onClick={(event) => setAnchor(event.currentTarget)}
          aria-haspopup="menu"
        >
          调整状态
        </Button>
      </div>
      <h2>{matter.title}</h2>
      <p>{matter.description}</p>
      <p className={styles.note}>
        {matter.agent} · {matter.type} · {dateText(matter.createdAt)}发起 ·{' '}
        {dateText(matter.updatedAt)}更新
      </p>
      <Menu
        anchor={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        actions={Object.entries(statusLabels).map(([status, label]) => ({
          id: status,
          label,
          disabled: action.busy || matter.status === status,
          onSelect: () => {
            if (status === 'abandoned') {
              setAnchor(null);
              setAbandon(true);
            } else void setStatus(status as MatterStatus);
          },
        }))}
      />
      {abandon ? (
        <div className={styles.section}>
          <Field label="废弃原因（选填）" htmlFor={`reason-${tab.id}`}>
            <Textarea
              id={`reason-${tab.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className={styles.actions}>
            <Button onClick={() => setAbandon(false)}>保留事项</Button>
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={async () => {
                if (
                  await action.run(() =>
                    service.hub.setMatterStatus(
                      spaceId,
                      matter.id,
                      'abandoned',
                      reason,
                    ),
                  )
                )
                  setAbandon(false);
              }}
            >
              确认废弃
            </Button>
          </div>
        </div>
      ) : null}
      {matter.status === 'waiting' && question ? (
        <section className={styles.section} aria-label="回应事项">
          <div className={styles.actions}>
            <h3>需要你的判断</h3>
            <span className={styles.note}>
              {answered} / {matter.questions.length} 已回答
            </span>
          </div>
          <div className={styles.filters} role="group" aria-label="切换问题">
            {matter.questions.map((q, i) => (
              <Button
                size="sm"
                key={q.id}
                aria-pressed={index === i}
                onClick={() => setIndex(i)}
              >
                问题 {i + 1}
                {answers[q.id]?.trim() ? ' · 已答' : ''}
              </Button>
            ))}
          </div>
          <h3>{question.title}</h3>
          <p className={styles.note}>
            {question.description}
            {question.required ? '（必答）' : '（选填）'}
          </p>
          {question.options ? (
            <div className={styles.choices}>
              {question.options.map((option) => (
                <Button
                  key={option}
                  aria-pressed={answers[question.id] === option}
                  onClick={() => answer(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : (
            <Textarea
              aria-label={question.title}
              rows={4}
              value={answers[question.id] ?? ''}
              onChange={(event) => answer(event.target.value)}
            />
          )}
          <div className={styles.actions}>
            <Button disabled={index === 0} onClick={() => setIndex(index - 1)}>
              上一题
            </Button>
            {index < matter.questions.length - 1 ? (
              <Button onClick={() => setIndex(index + 1)}>下一题</Button>
            ) : (
              <Button
                variant="primary"
                disabled={!ready || action.busy}
                onClick={() =>
                  void action.run(() =>
                    service.hub.answerMatter(spaceId, matter.id, answers),
                  )
                }
              >
                统一提交回应
              </Button>
            )}
          </div>
        </section>
      ) : matter.status === 'waiting' ? (
        <section className={styles.section}>
          <h3>补充你的判断</h3>
          <p className={styles.note}>
            这件事项还没有具体问题，可以先围绕它继续讨论。
          </p>
          <Button
            onClick={() =>
              workbench?.controller.launch(workbench.scopeKey, 'chat', {
                title: matter.title,
                draft: `关于「${matter.title}」：`,
              })
            }
          >
            继续讨论
          </Button>
        </section>
      ) : null}
      {matter.status === 'planning' ? (
        <section className={styles.section}>
          <h3>正在规划什么</h3>
          <p>{matter.plan}</p>
        </section>
      ) : null}
      {matter.status === 'abandoned' && matter.reason ? (
        <section className={styles.section}>
          <h3>废弃原因</h3>
          <p>{matter.reason}</p>
        </section>
      ) : null}
      <section className={styles.section}>
        <h3>事情的来龙去脉</h3>
        <ol className={styles.timeline}>
          {matter.timeline.map((event) => (
            <li key={event.id}>
              <small>{dateText(event.at)}</small>
              <strong>{event.title}</strong>
              <p>{event.detail}</p>
            </li>
          ))}
        </ol>
      </section>
      {matter.docIds.length ? (
        <section className={styles.section}>
          <h3>相关文档</h3>
          {matter.docIds.map((id) => {
            const doc = nodes.find((node) => node.id === id);
            return doc ? (
              <Button
                key={id}
                variant="ghost"
                className={styles.document}
                onClick={() =>
                  workbench?.controller.launch(workbench.scopeKey, 'document', {
                    documentId: id,
                    title: doc.title || '无标题',
                  })
                }
              >
                {doc.title || '无标题'}
              </Button>
            ) : null;
          })}
        </section>
      ) : null}
      {action.error ? (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      ) : null}
    </div>
  );
}
