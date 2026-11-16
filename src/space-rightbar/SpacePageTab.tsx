/**
 * Body component of the `alter-space.page` right-sidebar tab type.
 *
 * Renders the full `SpaceApp` (vendor UI, unmodified) against a private
 * in-memory router: each tab instance browses its own route and never touches
 * the host URL or the main panel's router. The route comes from the params
 * the opener attached to `ctx.sidebarRight.openTab(kind, { params })`;
 * a re-open that bumps `navigation.revision` re-targets the private router.
 * The Host-backed services arrive through `src/space-rightbar/context.ts`;
 * before assembly wires them the tab shows an 「空间页面不可用」 placeholder.
 *
 * Above the app sits a one-line bar carrying the primary action
 * 「新建对话」: it creates a conversation that auto-references what the app is
 * showing (the current page, else the space) and opens it beside the tab — the
 * tab itself never navigates. The bar also carries the inline failure copy, so
 * a failed creation never turns into a toast. The bar is always present: the
 * action must stay reachable after the user browses inside the tab, and its
 * context line doubles as the empty-state guide.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Orbit, Plus } from 'lucide-react';
import { SpaceApp } from '@alter/ui-space/SpaceApp';
import { spacePageServices, uiBridge } from './context';
import {
  NEW_CHAT_FAILED,
  NEW_CHAT_NO_TARGET,
  NEW_CHAT_UNAVAILABLE,
  createNewChatRunner,
  currentTabTarget,
  newChatBridge,
  type NewChatRunner,
} from './new-chat';
import {
  createSpacePageTabRouter,
  decideTabNavigation,
  initialSpacePageTabPath,
  parseSpacePageParams,
} from './tab-router';
import type {
  SidebarTabInfo,
  SidebarTabNavigation,
} from '../integration/dsh';
import styles from './SpacePageTab.module.css';

/** Empty-state copy: the tab holds no page target yet. */
const GUIDE_TEXT = '在右侧打开空间页面，或直接新建对话';

export interface SpacePageTabProps {
  /** Seat-injected tab hook; absent when the body renders outside a seat. */
  useTabInfo?: () => SidebarTabInfo | null;
}

/** Stand-in hook so the tab hook is read unconditionally on every render. */
const noTabInfo: () => SidebarTabInfo | null = () => null;

/** Guide entry-card icon (the tab def's `icon: ComponentType<{size?:number}>`). */
export function SpacePageGuideIcon({ size }: { size?: number }) {
  return <Orbit size={size ?? 18} strokeWidth={1.6} aria-hidden="true" />;
}

export function SpacePageTab({ useTabInfo }: SpacePageTabProps) {
  const services = spacePageServices();
  const readTabInfo = useTabInfo ?? noTabInfo;
  const info = readTabInfo();
  const navigation = info?.tab.navigation ?? null;
  const params = navigation?.params;
  const revision = navigation?.revision;

  // One private router per tab instance, stable for its lifetime (`keepMounted`
  // keeps it — and scroll positions — across tab switches). The initial route
  // is fixed at mount from the opening params; later re-targets go through the
  // revision effect below, never through re-derived initial params.
  const openedNavigation = useRef<SidebarTabNavigation | null>(navigation);
  const router = useMemo(
    () =>
      createSpacePageTabRouter(
        initialSpacePageTabPath(
          parseSpacePageParams(openedNavigation.current?.params),
        ),
      ),
    [],
  );

  // The framework re-targets an open tab by bumping navigation.revision. When
  // the new params carry a page target, move the private router there
  // (identical paths skip); without a target the tab keeps the route the user
  // navigated to. Params always travel with their revision, so the effect
  // deps on the revision only.
  const appliedRevision = useRef<number | null>(null);
  useEffect(() => {
    const decision = decideTabNavigation(
      // Only the previous revision is consulted; the recorded path is ignored.
      { revision: appliedRevision.current, path: null },
      revision === undefined ? null : { params, revision },
    );
    appliedRevision.current = decision.revision;
    if (decision.path !== null && decision.path !== router.getPath()) {
      router.navigate(decision.path, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params ride on the revision
  }, [revision, router]);

  // 「新建对话」auto-references what the app is showing. The private router is
  // the app's own route state, so a document route means "that page" and any
  // other space view means "the space"; the opening params only seed the
  // initial route (`initialSpacePageTabPath`) and act as a fallback before the
  // app has navigated.
  const path = useSyncExternalStore(router.subscribe, router.getPath);
  const routeTarget = currentTabTarget(path);
  const target =
    routeTarget.spaceId === undefined
      ? parseSpacePageParams(params)
      : routeTarget;
  const hasTarget = target.spaceId !== undefined;

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runner = useMemo<NewChatRunner>(() => createNewChatRunner(), []);
  const service = services?.service ?? null;
  // The bridge is installed by the assembly before the tab type registers; a
  // render without it keeps the button disabled with an explanation.
  const bridge = newChatBridge(uiBridge());
  const canCreate = service !== null && bridge !== null && hasTarget;
  const disabled = pending || !canCreate;
  const disabledReason = pending
    ? null
    : bridge === null || service === null
      ? NEW_CHAT_UNAVAILABLE
      : hasTarget
        ? null
        : `${NEW_CHAT_NO_TARGET}；先在左侧选择一个空间`;
  const hint = hasTarget
    ? target.nodeId === undefined
      ? '对话将引用当前空间'
      : '对话将引用当前页面'
    : GUIDE_TEXT;

  const handleNewChat = () => {
    if (disabled || service === null || bridge === null) return;
    setError(null);
    setPending(true);
    void runner
      .run({
        params: target,
        // The bridge opens the conversation beside the page (`open: 'aside'`);
        // `runNewChat` therefore needs no opener of its own.
        startPageChat: (ref) => bridge.startPageChat(ref),
        getNode: (nodeId) => service.getNode(nodeId),
        getSpaceName: (spaceId) =>
          service.getSpace(spaceId).then((space) => space?.name),
        onError: setError,
      })
      .then(
        () => setPending(false),
        () => {
          // `runNewChat` never rejects; keep the button usable if it ever does.
          setError(NEW_CHAT_FAILED);
          setPending(false);
        },
      );
  };

  if (!services) {
    return (
      <div className={styles.pageTab} data-alter-space-page-tab="">
        <div className={styles.unavailable}>空间页面不可用</div>
      </div>
    );
  }

  return (
    <div className={styles.pageTab} data-alter-space-page-tab="">
      <header className={styles.guide}>
        <span className={styles.guideText}>{hint}</span>
        {error === null ? null : (
          <span className={styles.guideError} role="alert">
            {error}
          </span>
        )}
        <button
          type="button"
          className={styles.newChat}
          disabled={disabled}
          title={disabledReason ?? undefined}
          onClick={handleNewChat}
        >
          {pending ? null : (
            <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
          )}
          {pending ? '创建中…' : '新建对话'}
        </button>
      </header>
      {/* 嵌入在 DSH 右栏标签里：空间视图不再渲染「打开右侧栏」入口。 */}
      <SpaceApp service={services.service} router={router} embedded />
    </div>
  );
}
