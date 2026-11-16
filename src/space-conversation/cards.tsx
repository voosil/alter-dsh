/**
 * Space/page reference cards inside sent user messages.
 *
 * DSH renders sent user text through the `conversation.user.text` factory:
 * a business package contributes a synchronous UserText rule plus a keyed
 * renderer on the `conversation.user.text.node` slot. This module owns both
 * halves for Space links (`src/chat/parse.ts` owns the link grammar):
 *
 * - `spaceRefRule` turns each Space link into one atomic `space-ref` node;
 * - `SpaceRefCard` renders that node as an inline reference card (type icon,
 *   name, type tag). An interactive card opens its target in the right sidebar
 *   through the Space bridge: the page tab for a page, the space entry for a
 *   space. A card whose reference state is `missing` is greyed, keeps its text
 *   readable and does not navigate; `archived` is greyed but still opens.
 *
 * The DSH conversation faces are mirrored as local structural types so the
 * client bundle never imports `@deepseek-ai/*` at runtime (self-contained
 * bundle rule). Names are link-local at P0 (tail segment of the node/space
 * id); readable names are the assembly layer's job later, carried through
 * `data.label`, while `data.raw` always keeps the exact link text.
 */
import { useRef, useState } from 'react';
import { FileText, Orbit } from 'lucide-react';
import { findSpaceLink, type SpaceLinkRef } from '../chat/parse';
import { spaceBridge } from '../integration/bridge';
import { formatRelativeTime } from './format';
import styles from './cards.module.css';

/** Rule id and renderer key; the conversation factory resolves both by it. */
export const SPACE_REF_ID = 'space-ref';

/** Factory order: after the Session/quote rules, before whitespace replacement. */
export const SPACE_REF_ORDER = 100;

/** DSH slot that carries keyed sent-user-text renderers. */
export const SPACE_REF_SLOT = 'conversation.user.text.node';

/** Slot priority of the Space reference renderer. */
export const SPACE_REF_PRIORITY = 100;

/** Resolved state of one reference (the Host derives it, never stored). */
export type SpaceRefState = 'current' | 'archived' | 'missing';

/** Copy shown for a state that makes the card non-navigable. */
export const SPACE_REF_MISSING_HINT = '该页面已被删除或无访问权限';
/** Copy shown for an archived page: still openable, but marked. */
export const SPACE_REF_ARCHIVED_HINT = '该页面已归档';

/**
 * Read one card's reference state. Injected by the assembly (`entry.js`) over
 * the chat store, which holds the Host-derived `state`; absent in tests and in
 * a boot without the store, where every card renders as current.
 */
export type SpaceRefStateResolver = (data: SpaceRefData) => SpaceRefState | undefined;

/** One reference preview (P1 悬停预览卡): page title, owning space, update time. */
export interface SpaceRefPreview {
  readonly title: string;
  readonly spaceName?: string;
  /** ISO timestamp of the last activity; formatted relative to now. */
  readonly updatedAt?: string;
}

/**
 * Read one card's preview. Injected by the assembly (`entry.js`) over the Host
 * lookups; absent in tests, where hovering shows no preview card.
 */
export type SpaceRefPreviewResolver = (
  data: SpaceRefData,
) => Promise<SpaceRefPreview | undefined>;

let previewResolver: SpaceRefPreviewResolver | null = null;

/** Install the preview resolver (assembly); `null` clears it. */
export function setSpaceRefPreviewResolver(
  resolver: SpaceRefPreviewResolver | null,
): void {
  previewResolver = resolver;
}

let refStateResolver: SpaceRefStateResolver | null = null;

/** Install the state resolver (assembly); `null` clears it. */
export function setSpaceRefStateResolver(resolver: SpaceRefStateResolver | null): void {
  refStateResolver = resolver;
}

/** State of one card, defaulting to current when nothing can be resolved. */
function refStateOf(data: SpaceRefData): SpaceRefState {
  try {
    return refStateResolver?.(data) ?? 'current';
  } catch {
    return 'current';
  }
}

/** JSON payload of one `space-ref` node (must stay JSON-serializable). */
export interface SpaceRefData {
  readonly kind: 'space' | 'page';
  readonly spaceId: string;
  readonly nodeId: string | null;
  /** P0 display name: tail segment of the node/space id. The assembly layer later fills readable names. */
  readonly label: string;
  /** The exact link text the node replaces (hover title, assembly-layer fallback). */
  readonly raw: string;
}

/** Atomic node the factory hands to the keyed `space-ref` renderer. */
export interface SpaceRefNode {
  readonly id: 'space-ref';
  readonly start: number;
  readonly end: number;
  readonly data: SpaceRefData;
}

/** Original-text replacement node the factory accepts; this rule never emits one. */
export interface SpaceRefTextReplacement {
  readonly id: 'text';
  readonly start: number;
  readonly end: number;
  readonly data: { readonly text: string; readonly display?: string };
}

/**
 * Structural face of a DSH user-text rule: one pure synchronous matcher the
 * factory calls repeatedly, advancing `from` to each accepted node's end.
 */
export interface SpaceRefRule {
  readonly id: 'space-ref';
  readonly order: number;
  match(
    text: string,
    from: number,
    context: unknown,
  ): SpaceRefNode | SpaceRefTextReplacement | undefined;
}

/** Tail segment of an id-shaped string; empty input keeps the fallback. */
function tailSegment(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const tail = value.split('/').filter(Boolean).at(-1);
  return tail === undefined || tail === '' ? fallback : tail;
}

/**
 * P0 display name of a Space reference, link-local: `data.label` first
 * (assembly layer may fill a readable name), else the tail segment of the
 * referenced id, else the raw link.
 */
export function spaceRefDisplayName(data: SpaceRefData): string {
  if (data.label !== '') return data.label;
  return tailSegment(data.kind === 'page' ? data.nodeId : data.spaceId, data.raw);
}

/** Card payload for one parsed link: link-local name plus the exact raw text. */
function spaceRefDataOf(ref: SpaceLinkRef, raw: string): SpaceRefData {
  return {
    kind: ref.kind,
    spaceId: ref.spaceId,
    nodeId: ref.nodeId,
    label: tailSegment(ref.kind === 'page' ? ref.nodeId : ref.spaceId, raw),
    raw,
  };
}

/** The next Space link at or after `from` becomes one atomic card node. */
export const spaceRefRule: SpaceRefRule = {
  id: SPACE_REF_ID,
  order: SPACE_REF_ORDER,
  match(text, from) {
    const found = findSpaceLink(text, from);
    if (found === null) return undefined;
    return {
      id: SPACE_REF_ID,
      start: found.start,
      end: found.end,
      data: spaceRefDataOf(found.ref, found.raw),
    };
  },
};

/** Renderer props as the conversation slot passes them. */
export interface SpaceRefCardProps {
  /** The `space-ref` node produced by `spaceRefRule`. */
  readonly node: SpaceRefNode;
  /** Whether the surrounding message allows interaction. */
  readonly interactive: boolean;
  /** Original text the node replaced (hover title). */
  readonly raw: string;
}

/**
 * Send one card's target to the right sidebar: a page opens the page tab, a
 * space opens that space's entry. The bridge is absent outside the client.
 */
function openInRightbar(data: SpaceRefData): void {
  const nodeId = data.kind === 'page' ? data.nodeId : null;
  if (data.kind === 'page' && (nodeId === null || nodeId === '')) return;
  spaceBridge()?.openPageInRightbar({ spaceId: data.spaceId, nodeId });
}

/**
 * Render one Space reference card.
 *
 * Both cards are buttons when the message is interactive: a page card opens
 * its page tab, a space card opens the space entry. Invalid-state rendering
 * (the assembly layer's `data.state`) is a P1 item.
 * @param props - node, interaction policy and the original link text.
 * @returns an inline card carrying type icon, name and type tag.
 */
export function SpaceRefCard({ node, interactive, raw }: SpaceRefCardProps) {
  const data = node.data;
  const state = refStateOf(data);
  const missing = state === 'missing';
  // Hover preview (P1): one Host lookup per card instance, shown at the card's
  // viewport corner so the transcript's vertical clipping cannot cut it.
  const requested = useRef(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [preview, setPreview] = useState<SpaceRefPreview | null>(null);
  const showPreview = (target: HTMLElement): void => {
    if (missing || previewResolver === null) return;
    const rect = target.getBoundingClientRect();
    setAnchor({ left: rect.left, top: rect.bottom + 6 });
    if (requested.current) return;
    requested.current = true;
    void previewResolver(data)
      .then((value) => {
        if (value !== undefined) setPreview(value);
      })
      .catch(() => {
        // A failed lookup simply shows no preview; the card stays usable.
        requested.current = false;
      });
  };
  const hidePreview = (): void => setAnchor(null);
  const clickable =
    interactive
    && !missing
    && (data.kind === 'space' || (data.nodeId !== null && data.nodeId !== ''));
  const hint = missing
    ? SPACE_REF_MISSING_HINT
    : state === 'archived'
      ? SPACE_REF_ARCHIVED_HINT
      : null;
  const fades = missing || state === 'archived';
  const title = hint === null ? raw : `${hint}（${raw}）`;
  const card = (
    <>
      {data.kind === 'page' ? (
        <FileText className={styles.icon} size={14} strokeWidth={1.6} aria-hidden="true" />
      ) : (
        <Orbit className={styles.icon} size={14} strokeWidth={1.6} aria-hidden="true" />
      )}
      <span className={styles.name}>{spaceRefDisplayName(data)}</span>
      <span className={styles.tag}>{data.kind === 'page' ? '页面' : '空间'}</span>
    </>
  );
  const className = fades
    ? `${styles.card} ${clickable ? styles.clickable : ''} ${styles.faded}`
    : `${styles.card} ${clickable ? styles.clickable : ''}`;
  const previewNode = anchor !== null && preview !== null
    ? createPreview(preview, anchor, data.kind)
    : null;
  if (!clickable) {
    return (
      <span className={className.trim()} title={title} data-state={state}>
        {card}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className.trim()}
      {...(fades ? { title } : {})}
      data-state={state}
      onMouseEnter={(event) => showPreview(event.currentTarget)}
      onMouseLeave={hidePreview}
      onFocus={(event) => showPreview(event.currentTarget)}
      onBlur={hidePreview}
      // 复制卡片本身得到原始链接（粘贴回来仍是一枚引用）；复制包含卡片的整句
      // 时不拦截——卡片 `user-select: none`，句子里本来就不带装饰。
      onCopy={(event) => {
        const selected = typeof window === 'undefined'
          ? ''
          : window.getSelection()?.toString().trim() ?? '';
        const own = event.currentTarget.textContent?.trim() ?? '';
        if (selected !== '' && selected !== own) return;
        event.clipboardData?.setData('text/plain', raw);
        event.preventDefault();
      }}
      onClick={() => openInRightbar(data)}
    >
      {card}
      {previewNode}
    </button>
  );
}

/**
 * Render the hover preview card at a viewport corner.
 *
 * `position: fixed` keeps it out of the transcript's `overflow-y: clip` flow
 * (DSH's transcript root clips vertical overflow without scrolling).
 */
function createPreview(
  preview: SpaceRefPreview,
  anchor: { left: number; top: number },
  kind: SpaceRefData['kind'],
) {
  const relative = preview.updatedAt === undefined
    ? ''
    : formatRelativeTime(preview.updatedAt, Date.now());
  const meta = [preview.spaceName ?? '', relative, kind === 'space' ? '空间' : '页面']
    .filter((part) => part !== '')
    .join(' · ');
  return (
    <span
      className={styles.preview}
      role="tooltip"
      style={{ left: anchor.left, top: anchor.top }}
    >
      <span className={styles.previewTitle}>{preview.title}</span>
      <span className={styles.previewMeta}>{meta}</span>
    </span>
  );
}
