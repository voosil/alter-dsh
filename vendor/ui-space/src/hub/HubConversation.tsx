import type { WorkbenchTab } from '@alter/ui-workbench';
import { Button, Textarea } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { useHub, useHubAction } from './context';
import styles from './Hub.module.css';
interface DiscussionDraft {
  answers: string[];
  input: string;
  finished?: boolean;
  history?: string[][];
}
export function HubConversation({ tab }: { tab: WorkbenchTab }) {
  const { service, spaceId, workbench } = useSpaceContext();
  const hub = useHub();
  const action = useHubAction();
  const observation = hub.observations.find((item) => item.id === tab.entityId);
  const purpose = tab.chatPurpose;
  const prompts =
    purpose === 'introduction'
      ? [
          '这个空间的背景是什么？有什么想长期推进的事情？',
          '你希望最终发生什么变化？',
          '眼前可以迈出的第一步是什么？',
        ]
      : purpose === 'plugin'
        ? [
            '给这个插件起一个名字。',
            '希望它怎样协助你？说说要记录的内容和使用方式。',
          ]
        : ['这套做法在什么情境下有用？请补充具体步骤，以及不适用的情况。'];
  let draft: DiscussionDraft = { answers: [], input: '' };
  try {
    if (tab.draft) draft = JSON.parse(tab.draft) as DiscussionDraft;
  } catch {
    /* A new discussion. */
  }
  const ready = draft.answers.length === prompts.length;
  function update(next: DiscussionDraft) {
    workbench?.controller.update(workbench.scopeKey, tab.id, {
      draft: JSON.stringify(next),
    });
  }
  async function save() {
    const ok = await action.run(async () => {
      if (purpose === 'introduction')
        await service.hub.introduce(
          spaceId,
          draft.answers[0]!,
          draft.answers[1]!,
          draft.answers[2]!,
        );
      else if (purpose === 'plugin')
        await service.hub.discoverPlugin(
          spaceId,
          draft.answers[0]!,
          draft.answers[1]!,
        );
      else if (tab.entityId)
        await service.hub.extractSkill(
          spaceId,
          tab.entityId,
          draft.answers[0]!,
        );
    });
    if (ok) {
      update({ ...draft, finished: true });
    }
  }
  const done = draft.finished;
  return (
    <div className={styles.conversation}>
      <div className={styles.discussion} role="log" aria-label={tab.title}>
        <h2>{tab.title}</h2>
        {observation ? (
          <p>
            {observation.title}：{observation.detail}
          </p>
        ) : null}
        {observation?.skill ? (
          <details>
            <summary>已保存的技能</summary>
            <p>{observation.skill.instructions}</p>
          </details>
        ) : null}
        {draft.history?.length ? (
          <details>
            <summary>之前的讨论（{draft.history.length}）</summary>
            {draft.history.map((answers, index) => (
              <article key={index}>
                {answers.map((answer, i) => (
                  <p key={i}>
                    {prompts[i]}：{answer}
                  </p>
                ))}
              </article>
            ))}
          </details>
        ) : null}
        {draft.answers.map((answer, i) => (
          <article key={i}>
            <small>Alter</small>
            <p>{prompts[i]}</p>
            <small>我</small>
            <p>{answer}</p>
          </article>
        ))}
        {!ready ? (
          <article>
            <small>Alter</small>
            <p>{prompts[draft.answers.length]}</p>
          </article>
        ) : (
          <section>
            <h3>
              {purpose === 'introduction'
                ? '这段旅程的起点'
                : purpose === 'plugin'
                  ? '插件草案'
                  : '技能草案'}
            </h3>
            <p>
              {purpose === 'introduction'
                ? `背景：${draft.answers[0]}\n愿景：${draft.answers[1]}\n下一步：${draft.answers[2]}`
                : purpose === 'plugin'
                  ? `${draft.answers[0]}\n${draft.answers[1]}\n\n以独立页面记录和编辑这些内容。`
                  : `${observation?.title}\n${draft.answers[0]}`}
            </p>
            {done ? (
              <>
                <p role="status">
                  {purpose === 'plugin'
                    ? '插件已加入配置列表。你可以选择开启它。'
                    : purpose === 'introduction'
                      ? '愿景与旅程已保存，随时可以继续修改。'
                      : '技能已保存，可以继续完善。'}
                </p>
                <Button
                  onClick={() =>
                    update({
                      answers: [],
                      input:
                        purpose === 'plugin' ? '' : (draft.answers[0] ?? ''),
                      history: [...(draft.history ?? []), draft.answers],
                    })
                  }
                >
                  {purpose === 'plugin'
                    ? '再创建一个插件'
                    : purpose === 'skill'
                      ? '继续完善技能'
                      : '重新讨论方向'}
                </Button>
              </>
            ) : (
              <div className={styles.actions}>
                <Button
                  onClick={() =>
                    update({
                      ...draft,
                      answers: draft.answers.slice(0, -1),
                      input: draft.answers.at(-1) ?? '',
                    })
                  }
                >
                  修改回答
                </Button>
                <Button
                  variant="primary"
                  disabled={action.busy}
                  onClick={() => void save()}
                >
                  {purpose === 'plugin'
                    ? '创建并加入列表'
                    : purpose === 'introduction'
                      ? '保存愿景与旅程'
                      : '保存技能'}
                </Button>
              </div>
            )}
          </section>
        )}
        {action.error ? (
          <p role="alert" className={styles.error}>
            {action.error}
          </p>
        ) : null}
      </div>
      {!ready ? (
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.input.trim())
              update({
                ...draft,
                answers: [...draft.answers, draft.input.trim()],
                input: '',
              });
          }}
        >
          {purpose === 'skill' ? (
            <span className={styles.skill} title="/skill-extract">
              技能提炼
            </span>
          ) : null}
          <Textarea
            aria-label="讨论回答"
            value={draft.input}
            rows={3}
            placeholder="聊聊你的想法…"
            onChange={(event) =>
              update({ ...draft, input: event.target.value })
            }
          />
          <div className={styles.actions}>
            {purpose === 'introduction' ? (
              <Button
                disabled={action.busy}
                onClick={async () => {
                  if (
                    await action.run(() =>
                      service.hub.skipIntroduction(spaceId),
                    )
                  )
                    workbench?.controller.close(workbench.scopeKey, tab.id);
                }}
              >
                暂时跳过
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={!draft.input.trim()}
            >
              发送回答
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
