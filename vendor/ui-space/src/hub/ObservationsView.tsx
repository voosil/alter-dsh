import { useState } from 'react';
import { Check, ArrowUpRight } from 'lucide-react';
import { Button } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { SpaceDetailShell } from '../views/SpaceDetailShell';
import { useHub, useHubAction, dateText } from './context';
import { useHubNavigation } from './navigation';
import styles from './Hub.module.css';
export function ObservationsView() {
  const { observations } = useHub();
  const { service, spaceId, workbench, nodes } = useSpaceContext();
  const action = useHubAction();
  const { openConversation } = useHubNavigation();
  const [kind, setKind] = useState<'behavior' | 'judgment'>('behavior');
  const items = observations.filter(
    (item) => item.kind === kind && (kind !== 'behavior' || item.count > 3),
  );
  return (
    <SpaceDetailShell
      active="observations"
      description="从反复出现的线索里，发现可以复用的方法与判断。"
    >
      <div className={styles.statusTabs} role="group" aria-label="观察类型">
        <Button
          aria-pressed={kind === 'behavior'}
          onClick={() => setKind('behavior')}
        >
          行为模式
        </Button>
        <Button
          aria-pressed={kind === 'judgment'}
          onClick={() => setKind('judgment')}
        >
          判断模式
        </Button>
      </div>
      {items.length ? (
        items.map((item) => (
          <article className={styles.observation} key={item.id}>
            <div className={styles.observationTitle}>
              <h3>{item.title}</h3>
              <span className={styles.observationCount}>
                {item.count} 次线索
              </span>
            </div>
            <p>{item.detail}</p>
            {item.accepted ? (
              <span className={styles.accepted}>
                <Check size={13} aria-hidden="true" />
                已认可
              </span>
            ) : null}
            <details className={styles.evidence}>
              <summary>查看依据</summary>
              <ul>
                {item.evidence.map((evidence, i) => (
                  <li key={i}>
                    <span className={styles.note}>
                      {dateText(evidence.date)} ·{' '}
                    </span>
                    {evidence.docId &&
                    nodes.some((node) => node.id === evidence.docId) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          workbench?.controller.launch(
                            workbench.scopeKey,
                            'document',
                            {
                              documentId: evidence.docId,
                              title: evidence.title,
                            },
                          )
                        }
                      >
                        {evidence.title}
                      </Button>
                    ) : (
                      evidence.title
                    )}
                  </li>
                ))}
              </ul>
            </details>
            {kind === 'behavior' ? (
              <>
                <Button
                  className={styles.observationAction}
                  onClick={() => openConversation('skill', item.id)}
                >
                  {item.skill ? '查看与完善技能' : '提炼为技能'}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Button>
                {item.skill ? (
                  <p className={styles.note}>已保存技能「{item.skill.name}」</p>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  aria-pressed={item.accepted}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      service.hub.acceptObservation(
                        spaceId,
                        item.id,
                        !item.accepted,
                      ),
                    )
                  }
                >
                  {item.accepted ? '撤回认可' : '认可这个判断'}
                </Button>
                {item.accepted ? (
                  <p className={styles.note}>
                    今后遇到相似决策时，Alter 可以参考这一判断；你随时可以撤回。
                  </p>
                ) : null}
              </>
            )}
          </article>
        ))
      ) : (
        <div className={styles.empty}>
          <h2>还没有足够的线索</h2>
          <p>
            {kind === 'behavior'
              ? '相似行为出现超过三次后，值得复用的模式会出现在这里。'
              : '随着记录与讨论积累，再回来看哪些判断反复成立。'}
          </p>
        </div>
      )}
      {action.error ? (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      ) : null}
    </SpaceDetailShell>
  );
}
