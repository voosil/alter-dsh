/**
 * 「新建对话」 right-sidebar entry.
 *
 * The guide page lists one box per entry a tab type contributes (see
 * `SidebarRightTabDefinition.guide`). Picking a box opens that type as a page,
 * so this type exists to be picked: its body creates the conversation the reader
 * asked for, then puts that conversation in the column as its own tab and says
 * so in place. The column never navigates the main view, and a failure stays
 * inline instead of becoming a toast.
 *
 * Which target: the Space main panel's current page (page reference) or its
 * current space when no page is open (space reference) — the reader is reading
 * that page beside the column, which is the whole point of 「新建对话」. When the
 * Space panel is not the main panel (a conversation page's right column) there
 * is no page beside the column, and the entry falls back to the default space
 * its own description promises.
 */
import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { spaceContinuity } from '../app/reload-continuity';
import { spacePageServices, uiBridge } from './context';
import {
  NEW_CHAT_FAILED,
  NEW_CHAT_UNAVAILABLE,
  guideTargetOf,
  newChatBridge,
  resolveAutoRef,
  type NewChatRef,
} from './new-chat';
import styles from './SpacePageTab.module.css';

/** Lifecycle of the creation this tab performs. */
export type NewChatStatus = 'creating' | 'created' | 'error';

/** Props the seat injects into a tab body. */
export interface NewChatTabProps {
  /** Seat-injected tab hook; absent when the body renders outside a seat. */
  useTabInfo?: () => unknown;
}

/**
 * Pick the space a guide-created conversation belongs to.
 * @param spaces - every space the reader can see.
 * @returns the default space, else the first one.
 */
export function defaultSpaceOf(
  spaces: readonly { id: string; name: string; isDefault?: boolean }[],
): { id: string; name: string } | null {
  const chosen = spaces.find((space) => space.isDefault === true) ?? spaces[0];
  if (chosen === undefined) return null;
  return { id: chosen.id, name: chosen.name };
}

/**
 * Render the entry's body: create once, then report where the conversation is.
 * @param _props - seat props; this body consumes none of them.
 * @returns the status view.
 */
export function NewChatTab(_props: NewChatTabProps) {
  const [status, setStatus] = useState<NewChatStatus>('creating');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const services = spacePageServices();
      const bridge = newChatBridge(uiBridge());
      if (services === null || bridge === null) {
        setError(NEW_CHAT_UNAVAILABLE);
        setStatus('error');
        return;
      }
      try {
        // The space main panel's route names what the reader is looking at; the
        // entry references exactly that, and only falls back to the default
        // space when the panel is not the centre.
        const continuity = spaceContinuity();
        const target = guideTargetOf(continuity.path, continuity.active);
        const auto = target.spaceId === undefined
          ? null
          : await resolveAutoRef(target, {
            getNode: (nodeId) => services.service.getNode(nodeId),
            getSpaceName: async (spaceId) => (await services.service.getSpace(spaceId))?.name,
          });
        let ref: NewChatRef | null = auto;
        if (ref === null) {
          const spaces = await services.service.listSpaces();
          const space = defaultSpaceOf(spaces);
          if (space !== null) {
            ref = { spaceId: space.id, nodeId: null, nodeTitle: space.name };
          }
        }
        if (ref === null) {
          setError('还没有可用的空间');
          setStatus('error');
          return;
        }
        // `startPageChat` opens the conversation beside the column (`open:
        // 'aside'`), so this body only reports the outcome; opening it again
        // here would toggle the column twice.
        await bridge.startPageChat(ref);
        setStatus('created');
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message !== ''
            ? `${NEW_CHAT_FAILED}（${cause.message}）`
            : NEW_CHAT_FAILED,
        );
        setStatus('error');
      }
    })();
  }, []);

  if (status === 'error') {
    return (
      <div className={styles.guide} role="alert">
        <p className={styles.guideText}>{error ?? NEW_CHAT_FAILED}</p>
      </div>
    );
  }
  if (status === 'created') {
    return (
      <div className={styles.guide}>
        <p className={styles.guideText}>对话已创建，已在右侧以「对话」标签打开。</p>
      </div>
    );
  }
  return (
    <div className={styles.guide} aria-busy="true">
      <p className={styles.guideText}>
        <MessageSquarePlus size={14} strokeWidth={1.7} aria-hidden="true" />
        {' 正在创建对话…'}
      </p>
    </div>
  );
}
