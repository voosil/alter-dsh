import type { ReactNode } from 'react';
import {
  ChevronRight,
  LayoutDashboard,
  Activity,
  Route,
  ScanEye,
  Settings2,
  Blocks,
} from 'lucide-react';
import { Button } from '@alter/ui-system';
import { WorkbenchToggle } from '@alter/ui-workbench';
import { useSpaceContext } from '../runtime';
import { useHub, hubPath } from '../hub/context';
import { DirectoryButton } from '../components/DirectoryButton';
import styles from './SpaceDetailShell.module.css';

export function SpaceDetailShell({
  active,
  meta,
  children,
  description,
}: {
  active: string;
  meta?: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  const { router, space, spaceId, workbench } = useSpaceContext();
  const hub = useHub();
  const current = hub.plugins.find((plugin) => plugin.id === active);
  const icons = {
    overview: LayoutDashboard,
    activity: Activity,
    journey: Route,
    observations: ScanEye,
    config: Settings2,
  };
  const waitingCount = hub.matters.filter(
    (matter) => matter.status === 'waiting',
  ).length;
  return (
    <section className={styles.page} aria-label="空间详情">
      <header className={styles.toolbar}>
        <DirectoryButton />
        <nav className={styles.crumbs} aria-label="目录层级">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => router.navigate(hubPath(spaceId, 'overview'))}
          >
            {space.name}
          </Button>
          <ChevronRight size={12} aria-hidden="true" />
          <span className={styles.currentCrumb}>
            {current?.label ?? '插件'}
          </span>
        </nav>
        {workbench ? (
          <WorkbenchToggle
            hideWhenOpen
            controller={workbench.controller}
            scopeKey={workbench.scopeKey}
          />
        ) : null}
      </header>
      <div className={styles.layout}>
        <nav
          className={styles.navigation}
          aria-label="空间详情导航"
          data-overview={active === 'overview' || undefined}
        >
          <div className={styles.navigationInner}>
            {hub.plugins
              .filter((plugin) => plugin.enabled)
              .map((plugin) => {
                const Icon = icons[plugin.id as keyof typeof icons] ?? Blocks;
                return (
                  <div className={styles.navGroup} key={plugin.id}>
                    <Button
                      variant="ghost"
                      className={styles.navItem}
                      aria-label={plugin.label}
                      aria-description={
                        plugin.id === 'activity' && waitingCount > 0
                          ? `${waitingCount} 件等你回应`
                          : undefined
                      }
                      aria-current={active === plugin.id ? 'page' : undefined}
                      onClick={() =>
                        router.navigate(hubPath(spaceId, plugin.id))
                      }
                    >
                      <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
                      {plugin.label}
                      {plugin.id === 'activity' && waitingCount > 0 ? (
                        <span className={styles.navCount} aria-hidden="true">
                          {waitingCount}
                        </span>
                      ) : null}
                    </Button>
                  </div>
                );
              })}
          </div>
        </nav>
        <div
          className={styles.scroll}
          data-overview={active === 'overview' || undefined}
        >
          <div
            className={styles.body}
            data-overview={active === 'overview' || undefined}
          >
            <header className={styles.head}>
              <h1 className={styles.name}>
                {active === 'overview'
                  ? space.name
                  : (current?.label ?? '插件不可用')}
              </h1>
              {description ? (
                <p className={styles.goal}>{description}</p>
              ) : null}
              {meta ? <div className={styles.meta}>{meta}</div> : null}
            </header>
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
