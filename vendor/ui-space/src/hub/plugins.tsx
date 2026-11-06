import type { SpaceHubRegistry } from './registry';
import { useState, useSyncExternalStore } from 'react';
import { Button, Textarea } from '@alter/ui-system';
import { SpaceDetailShell } from '../views/SpaceDetailShell';
import { useHub, useHubAction, hubPath } from './context';
import { useSpaceContext } from '../runtime';
import styles from './Hub.module.css';

export function SpaceHubView({
  pluginId,
  registry,
}: {
  pluginId: string;
  registry: SpaceHubRegistry;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
  );
  const { plugins } = useHub();
  const { router, spaceId } = useSpaceContext();
  const manifest = plugins.find((plugin) => plugin.id === pluginId);
  if (!manifest?.enabled)
    return (
      <SpaceDetailShell active={pluginId}>
        <div className={styles.empty}>
          <h2>{manifest ? '这个插件已关闭' : '没有找到这个插件'}</h2>
          <p>你可以在配置中查看这个空间可用的插件。</p>
          <Button onClick={() => router.navigate(hubPath(spaceId, 'config'))}>
            打开配置
          </Button>
        </div>
      </SpaceDetailShell>
    );
  const entry = entries.find((plugin) => plugin.id === pluginId);
  if (entry) {
    const Page = entry.component;
    return <Page />;
  }
  if (!manifest.builtin)
    return (
      <CustomPlugin
        key={manifest.id}
        id={manifest.id}
        initialContent={manifest.content ?? ''}
      />
    );
  return (
    <SpaceDetailShell active={pluginId}>
      <p role="alert">插件未能加载，请重新打开空间。</p>
    </SpaceDetailShell>
  );
}
function CustomPlugin({
  id,
  initialContent,
}: {
  id: string;
  initialContent: string;
}) {
  const { service, spaceId, toast } = useSpaceContext();
  const [content, setContent] = useState(initialContent);
  const [saved, setSaved] = useState(initialContent);
  const action = useHubAction();
  return (
    <SpaceDetailShell active={id}>
      <form
        className={styles.form}
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await action.run(() =>
              service.hub.savePluginContent(spaceId, id, content),
            )
          ) {
            setSaved(content);
            toast('插件内容已保存');
          }
        }}
      >
        <Textarea
          rows={16}
          aria-label="插件内容"
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <div className={styles.actions}>
          <Button
            disabled={content === saved || action.busy}
            onClick={() => setContent(saved)}
          >
            还原修改
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={content === saved || action.busy}
          >
            保存内容
          </Button>
        </div>
        {action.error ? <p role="alert">{action.error}</p> : null}
      </form>
    </SpaceDetailShell>
  );
}
