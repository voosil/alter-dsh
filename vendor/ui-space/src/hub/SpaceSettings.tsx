import { Button } from '@alter/ui-system';
import {
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

/** Title (visible on the segment) + the one sentence shown for the choice. */
const policies = [
  ['ask', '始终询问', '行动前先征得你的同意。'],
  ['judge', 'Agent 判断', '按上下文判断是否需要询问。'],
  ['autonomous', '完全自主', '自主推进，并留下过程记录。'],
] as const;

const pluginIcons = {
  overview: LayoutDashboard,
  activity: Activity,
  journey: Route,
  observations: ScanEye,
  config: Settings2,
};

/**
 * Agent 的权限档位：三个互斥选项压成一行分段控件，只解释当前选中的那个，
 * 不再并排铺三张说明卡。
 */
export function DecisionPolicy() {
  const hub = useHub();
  const { service, spaceId } = useSpaceContext();
  const action = useHubAction();
  const current = policies.find(([value]) => value === hub.policy);
  return (
    <>
      <div className={styles.policyControl} role="group" aria-label="Agent 的决定权限">
        {policies.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={styles.policyOption}
            data-selected={hub.policy === value || undefined}
            aria-pressed={hub.policy === value}
            disabled={action.busy}
            onClick={() =>
              void action.run(() => service.hub.setPolicy(spaceId, value))
            }
          >
            {label}
          </button>
        ))}
      </div>
      {current ? <p className={styles.policyDetail}>{current[2]}</p> : null}
      {action.error ? (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      ) : null}
    </>
  );
}

/**
 * 空间插件：必需的插件只标记「内置」，可选的插件才给出开关，避免每个插件
 * 都重复一行「保持开启」+ 一个禁用开关。
 */
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
                <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
              </span>
              <div className={styles.pluginText}>
                <strong>{plugin.label}</strong>
                <p>{plugin.description}</p>
              </div>
              {plugin.required ? (
                <span className={styles.pluginBadge}>内置</span>
              ) : (
                <Button
                  className={styles.pluginToggle}
                  role="switch"
                  aria-checked={plugin.enabled}
                  aria-label={`${plugin.label}插件`}
                  disabled={action.busy}
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
              )}
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
