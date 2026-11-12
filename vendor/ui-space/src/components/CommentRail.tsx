import {
  useCallback,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Comment } from '@alter/protocol';
import { findQuoteOffsets, findQuoteRange } from '../utils/editor-text';
import { CommentCard } from './CommentCard';
import { CommentComposer } from './CommentComposer';
import styles from './CommentRail.module.css';

const PENDING_KEY = '__pending__';
const GAP = 12;

export function CommentRail({
  comments,
  activeCommentId,
  anchorRoot,
  pendingQuote,
  open,
  stacked,
  onActivate,
  onAddPending,
  onCancelPending,
  onPendingDraftChange,
  onApprove,
  onEdit,
  onSupplement,
  onDelete,
}: {
  comments: Comment[];
  activeCommentId: string | null;
  anchorRoot: HTMLElement | null;
  pendingQuote: string | null;
  open: boolean;
  stacked: boolean;
  onActivate: (id: string | null) => void;
  onAddPending: (body: string, quote: string) => Promise<void>;
  onCancelPending: () => void;
  onPendingDraftChange?: (hasContent: boolean) => void;
  onApprove: (id: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onSupplement: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const layoutId = useId();
  const reserved = useRef<Record<number, number>>({});
  const [spacingRules, setSpacingRules] = useState('');
  useLayoutEffect(() => {
    if (!anchorRoot) return;
    anchorRoot.setAttribute('data-comment-layout', layoutId);
    return () => {
      anchorRoot.removeAttribute('data-comment-layout');
    };
  }, [anchorRoot, layoutId]);
  const railRef = useRef<HTMLElement>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [spacer, setSpacer] = useState(0);
  const inlineComments = useMemo(() => {
    const list = comments.filter(
      (comment) => comment.status === 'open' && comment.quote !== null,
    );
    if (!anchorRoot) return list;
    const text = anchorRoot.textContent ?? '';
    return list
      .map((comment, index) => ({
        comment,
        index,
        offset:
          comment.quote === null
            ? Number.POSITIVE_INFINITY
            : (findQuoteOffsets(text, comment.quote)?.start ??
              Number.POSITIVE_INFINITY),
      }))
      .sort((a, b) => a.offset - b.offset || a.index - b.index)
      .map((entry) => entry.comment);
  }, [anchorRoot, comments]);

  const measure = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    if (!open || !anchorRoot) {
      reserved.current = {};
      setSpacingRules('');
      setPositions((current) => (Object.keys(current).length ? {} : current));
      setSpacer((current) => (current === 0 ? current : 0));
      return;
    }
    const railTop = rail.getBoundingClientRect().top;
    const slots = [
      ...rail.querySelectorAll<HTMLElement>('[data-comment-slot]'),
    ];
    const slotById = new Map(
      slots.map((slot) => [slot.dataset.slotId ?? '', slot]),
    );
    const editor = anchorRoot.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    const nextReserved: Record<number, number> = {};
    const entries: {
      key: string;
      top: number;
      height: number;
      order: number;
      blockIndex?: number;
    }[] = [];
    const addEntry = (key: string, quote: string, order: number) => {
      const slot = slotById.get(key);
      if (!slot) return;
      const range = findQuoteRange(anchorRoot, quote);
      let block =
        range?.endContainer instanceof Element
          ? range.endContainer
          : range?.endContainer.parentElement;
      while (block && block.parentElement !== editor)
        block = block.parentElement;
      const blockIndex =
        block && editor
          ? Array.from(editor.children).indexOf(block) + 1
          : undefined;
      const anchorTop =
        stacked && block && blockIndex
          ? block.getBoundingClientRect().bottom -
            (reserved.current[blockIndex] ?? 0) -
            railTop +
            GAP
          : range
            ? range.getBoundingClientRect().top - railTop
            : Number.POSITIVE_INFINITY;
      entries.push({
        key,
        top: anchorTop,
        height: slot.offsetHeight,
        order,
        blockIndex,
      });
    };
    if (pendingQuote !== null) addEntry(PENDING_KEY, pendingQuote, -1);
    inlineComments.forEach((comment, index) => {
      if (comment.quote !== null) addEntry(comment.id, comment.quote, index);
    });
    entries.sort((a, b) => {
      if (a.top !== b.top) {
        if (a.top === Number.POSITIVE_INFINITY) return 1;
        if (b.top === Number.POSITIVE_INFINITY) return -1;
        return a.top - b.top;
      }
      return a.order - b.order;
    });
    const next: Record<string, number> = {};
    let cursor = 0;
    for (const entry of entries) {
      const anchor = Number.isFinite(entry.top) ? entry.top : cursor;
      const top = Math.max(0, anchor, cursor);
      next[entry.key] = top;
      cursor = top + entry.height + GAP;
      if (stacked && entry.blockIndex)
        nextReserved[entry.blockIndex] =
          (nextReserved[entry.blockIndex] ?? GAP) + entry.height + GAP;
    }
    reserved.current = nextReserved;
    setSpacingRules(
      stacked
        ? Object.entries(nextReserved)
            .map(
              ([index, height]) =>
                `[data-comment-layout="${layoutId}"] [contenteditable="true"] > :nth-child(${index}) { padding-bottom: ${height}px; }`,
            )
            .join('\n')
        : '',
    );
    setPositions((current) => {
      const keys = Object.keys(next);
      if (
        keys.length === Object.keys(current).length &&
        keys.every((key) => current[key] === next[key])
      )
        return current;
      return next;
    });
    setSpacer((current) => (current === cursor ? current : cursor));
  }, [anchorRoot, inlineComments, open, pendingQuote, stacked, layoutId]);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, [measure]);

  useEffect(() => {
    if (!open) {
      const rail = railRef.current;
      const active = document.activeElement;
      if (rail && active instanceof HTMLElement && rail.contains(active))
        active.blur();
      return;
    }
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    }
    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(schedule);
    for (const slot of rail.querySelectorAll('[data-comment-slot]'))
      resizeObserver.observe(slot);
    if (anchorRoot) {
      resizeObserver.observe(anchorRoot);
      mutationObserver.observe(anchorRoot, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [anchorRoot, measure, open, stacked]);

  return (
    <aside
      ref={railRef}
      className={styles.rail}
      aria-label="评论"
      data-stacked={stacked || undefined}
      data-open={open || undefined}
      aria-hidden={!open}
      inert={!open}
    >
      {spacingRules ? <style>{spacingRules}</style> : null}
      <span
        className={styles.spacer}
        style={{ height: spacer }}
        aria-hidden="true"
      />
      {pendingQuote !== null ? (
        <div
          className={styles.pendingSlot}
          data-comment-slot=""
          data-slot-id={PENDING_KEY}
          data-ready={positions[PENDING_KEY] !== undefined ? true : undefined}
          style={{ top: positions[PENDING_KEY] ?? 0 }}
        >
          <CommentComposer
            key={pendingQuote}
            quote={pendingQuote}
            autoFocus
            onAdd={(body) => onAddPending(body, pendingQuote)}
            onCancel={onCancelPending}
            onDraftChange={onPendingDraftChange}
          />
        </div>
      ) : null}
      {inlineComments.map((comment) => (
        <div
          key={comment.id}
          className={styles.cardSlot}
          data-comment-slot=""
          data-slot-id={comment.id}
          data-ready={positions[comment.id] !== undefined ? true : undefined}
          style={{ top: positions[comment.id] ?? 0 }}
        >
          <CommentCard
            comment={comment}
            active={activeCommentId === comment.id}
            onActivate={onActivate}
            onApprove={onApprove}
            onEdit={onEdit}
            onSupplement={onSupplement}
            onDelete={onDelete}
          />
        </div>
      ))}
    </aside>
  );
}
