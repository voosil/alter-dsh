import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './PanelResizer.module.css';

const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 48;

export interface PanelResizerProps {
  panelRef: RefObject<HTMLElement | null>;
  label: string;
  /** The panel edge occupied by the handle. */
  edge: 'left' | 'right';
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
  className?: string;
}

/** Shared pointer, keyboard and visual behavior; the consumer owns width persistence. */
export function PanelResizer({
  panelRef,
  label,
  edge,
  min,
  max,
  onResize,
  onReset,
  className,
}: PanelResizerProps) {
  const direction = edge === 'right' ? 1 : -1;
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const [dragging, setDragging] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const update = () =>
      setMeasuredWidth(Math.round(element.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panelRef]);

  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  function currentWidth() {
    return panelRef.current?.getBoundingClientRect().width ?? 0;
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: currentWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onResize(
      clamp(drag.startWidth + direction * (event.clientX - drag.startX)),
    );
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onResize(event.key === 'Home' ? min : max);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const delta = event.key === 'ArrowRight' ? step : -step;
    onResize(clamp(currentWidth() + direction * delta));
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={measuredWidth ?? undefined}
        tabIndex={0}
        className={[styles.resizer, className].filter(Boolean).join(' ')}
        data-dragging={dragging || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={handleKeyDown}
        onDoubleClick={onReset}
      />
      {dragging
        ? createPortal(
            <div className={styles.shield} aria-hidden="true" />,
            document.body,
          )
        : null}
    </>
  );
}
