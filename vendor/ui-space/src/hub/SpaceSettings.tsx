import { Button } from '@alter/ui-system';
import {
  Circle,
  CheckCircle2,
  LayoutDashboard,
  Activity,
  Route,
  ScanEye,
  Settings2,
  Blocks,
} from 'lucide-react';
import { useSpaceContext } from '../runtime';
import { useHub, useHubAction } from './context';
import styles from './Hub.module.css';

const policies = [
  ['ask', '始终询问', '主动行动前，先交给你确认。'],
  ['judge', 'Agent 判断', '结合上下文、过往判断和执行成本决定是否询问。'],
  ['autonomous', '完全自主', '允许 Agent 自主推进，并留下过程记录。'],
] as const;

const pluginIcons = {
  overview: LayoutDashboard,
  activity: Activity,
  journey: Route,
  observations: ScanEye,
  config: Settings2,
};

export function DecisionPolicy() {
  const hub = useHub();
  const { service, spaceId } = useSpaceContext();
  const action = useHubAction();
  return (
    <>
      <div
        className={styles.policyChoices}
        role="group"
        aria-label="Agent 的决定权限"
      >
        {policies.map(([value, label, detail]) => (
          <Button
            key={value}
            aria-pressed={hub.policy === value}
            disabled={action.busy}
            onClick={() =>
              void action.run(() => service.hub.setPolicy(spaceId, value))
            }
          >
            <span className={styles.policyText}>
              <strong>{label}</strong>
              <span>{detail}</span>
            </span>
            {hub.policy === value ? (
              <CheckCircle2 size={18} aria-hidden="true" />
            ) : (
              <Circle size={18} aria-hidden="true" />
            )}
          </Button>
        ))}
      </div>
      {action.error ? (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      ) : null}
    </>
  );
}

export function SpacePlugins() {
  const hub = useHub();
  const { service, spaceId } = useSpaceContext();
  const action = useHubAction();
  return (
    <>
      <ul className={styles.plugins}>
        {hub.plugins.map((plugin) => {
          const Icon =
            pluginIcons[plugin.id as keyof typeof pluginIcons] ?? Blocks;
          return (
            <li key={plugin.id}>
              <span className={styles.pluginIcon}>
                <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <div className={styles.pluginText}>
                <strong>{plugin.label}</strong>
                <p>{plugin.description}</p>
                {plugin.required ? <p>保持开启</p> : null}
              </div>
              <Button
                className={styles.pluginToggle}
                role="switch"
                aria-checked={plugin.enabled}
                aria-label={`${plugin.label}插件`}
                disabled={plugin.required || action.busy}
                onClick={() =>
                  void action.run(() =>
                    service.hub.setPluginEnabled(
                      spaceId,
                      plugin.id,
                      !plugin.enabled,
                    ),
                  )
                }
              >
                <span className={styles.toggleTrack} aria-hidden="true">
                  <span />
                </span>
                <span>{plugin.enabled ? '已开启' : '已关闭'}</span>
              </Button>
            </li>
          );
        })}
      </ul>
      {action.error ? (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      ) : null}
    </>
  );
}
