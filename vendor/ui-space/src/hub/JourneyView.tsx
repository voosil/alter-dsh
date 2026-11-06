import { useState } from 'react';
import { PencilLine } from 'lucide-react';
import type { Journey } from '@alter/protocol';
import { Button, Field, Textarea } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { SpaceDetailShell } from '../views/SpaceDetailShell';
import { useHub, useHubAction, dateText } from './context';
import { useHubNavigation } from './navigation';
import styles from './Hub.module.css';
import { JourneyCanvas } from './JourneyCanvas';
const fields = [
  ['vision', '愿景和目标'],
  ['shortTerm', '短期规划'],
  ['longTerm', '长期规划'],
  ['principles', '经验与判断'],
] as const;
type Editable = Pick<Journey, (typeof fields)[number][0]>;
export function JourneyView() {
  const { journey } = useHub();
  const { service, spaceId } = useSpaceContext();
  const { openMatter, openConversation } = useHubNavigation();
  const action = useHubAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Editable>(journey);
  return (
    <SpaceDetailShell
      active="journey"
      description="从哪里出发，现在在哪里，接下来去向何处。"
    >
      <section className={`${styles.section} ${styles.journeySection}`}>
        <div className={styles.actions}>
          <h2>一路走来</h2>
          <Button size="sm" onClick={() => openConversation('introduction')}>
            聊聊方向
          </Button>
        </div>
        {journey.nodes.length ? (
          <JourneyCanvas
            nodes={journey.nodes}
            onOpenMatter={(id) => void openMatter(id)}
          />
        ) : (
          <div className={styles.empty}>
            <p>这段旅程还没有开始。聊聊背景和期待，留下第一步。</p>
            <Button onClick={() => openConversation('introduction')}>
              开始讨论
            </Button>
          </div>
        )}
      </section>
      <details className={styles.planDisclosure}>
        <summary>
          愿景与规划<span>{journey.vision || '从一个期待开始'}</span>
        </summary>
        <div className={styles.actions}>
          <span className={styles.note}>
            更新于 {dateText(journey.updatedAt)}
          </span>
          <Button
            onClick={() => {
              setDraft(journey);
              setEditing(true);
            }}
          >
            <PencilLine size={14} aria-hidden="true" />
            编辑愿景与规划
          </Button>
        </div>
        {editing ? (
          <form
            className={styles.form}
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await action.run(() =>
                  service.hub.saveJourney(spaceId, {
                    vision: draft.vision,
                    shortTerm: draft.shortTerm,
                    longTerm: draft.longTerm,
                    principles: draft.principles,
                  }),
                )
              )
                setEditing(false);
            }}
          >
            {fields.map(([key, label]) => (
              <Field key={key} label={label} htmlFor={`journey-${key}`}>
                <Textarea
                  id={`journey-${key}`}
                  rows={3}
                  value={draft[key]}
                  onChange={(event) =>
                    setDraft({ ...draft, [key]: event.target.value })
                  }
                />
              </Field>
            ))}
            <div className={styles.actions}>
              <Button disabled={action.busy} onClick={() => setEditing(false)}>
                取消修改
              </Button>
              <Button variant="primary" type="submit" disabled={action.busy}>
                保存愿景与规划
              </Button>
            </div>
          </form>
        ) : (
          <div className={styles.journeyPlan}>
            {fields.map(([key, label]) => (
              <section key={key} className={styles.planField} data-field={key}>
                <h2>{label}</h2>
                <p>{journey[key] || '还没有记录，可以从一次讨论开始。'}</p>
              </section>
            ))}
          </div>
        )}
        {action.error ? (
          <p role="alert" className={styles.error}>
            {action.error}
          </p>
        ) : null}
      </details>
    </SpaceDetailShell>
  );
}
