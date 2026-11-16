import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { DocWidthMetrics } from '../utils/useDocWidth';
import styles from './DocWidthHandle.module.css';

/** 键盘微调步长（px）。 */
const KEYBOARD_STEP = 16;
/** Shift + 方向键的步长（px）。 */
const KEYBOARD_STEP_LARGE = 48;
/** 指针位移超过该值才算拖动，用来区分「拖动后的合成 click」与真正点击。
 *  取值要大于手抖/触控板双击的常见漂移（约 6px），否则普通双击会被当成拖动。 */
const DRAG_CLICK_SLOP = 10;
/** 拖动合成的 click 在该窗口内到达时，同一手势合成的双击不触发复位。 */
const DOUBLE_CLICK_GUARD_MS = 500;

export interface DocWidthHandleProps {
  /** 拖动柄的无障碍名称。 */
  label: string;
  /** 当前生效宽度（px）；量不出布局时作为拖动起点。 */
  width: number;
  min: number;
  max: number;
  /**
   * 指针位移 1px 对应的宽度增量。
   *
   * 正文栏居中，拖动右缘时左右两侧同时变化，宽度增量是指针位移的 2 倍，
   * 手柄才会一直贴着指针；默认 2。
   */
  scale?: number;
  /** 拖动开始时重测当前宽度与上限，返回 `UNMEASURED` 时退回 props。 */
  measure?: () => DocWidthMetrics;
  onChange: (width: number) => void;
  onReset: () => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  /** 拖动开始时的正文栏宽度（实测值）。 */
  startWidth: number;
  /** 本次拖动允许的上限（实测值）。 */
  maxWidth: number;
}

/**
 * 正文栏右缘的垂直拖动柄。
 *
 * 只负责指针/键盘交互与视觉；宽度持久化归调用方（与 `PanelResizer` 的分工一致）。
 * 静息不可见：hover、键盘聚焦或拖动时才显示强调色竖线，不改变文档页的静息视觉。
 */
export function DocWidthHandle({
  label,
  width,
  min,
  max,
  scale: scaleProp,
  measure,
  onChange,
  onReset,
}: DocWidthHandleProps) {
  const scale = scaleProp ?? 2;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  /** 本次按压是否移动过：拖动结束后的合成 click 不算双击。 */
  const movedRef = useRef(false);
  /** 最近一次由拖动合成的 click 时间戳；null 表示没有。 */
  const dragClickAtRef = useRef<number | null>(null);

  // 拖动期间统一指针与选区：跨过正文、评论轨时都不应选中文字或切换光标。
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

  function clampWidth(value: number, upper: number): number {
    return Math.min(upper, Math.max(min, Math.round(value)));
  }

  /**
   * 只在宽度真的变化时才上报。
   *
   * 可用宽度被评论轨等收窄时，显示的宽度可能已经小于已存偏好；此时向「更宽」方向
   * 的任何操作都会被 clamp 回当前宽度，照旧上报会把更大的偏好静默改小。
   */
  function commitWidth(next: number, reference: number): void {
    if (next === reference) return;
    onChange(next);
  }

  function releaseCapture(
    element: HTMLDivElement,
    pointerId: number,
  ): void {
    if (
      typeof element.hasPointerCapture === 'function' &&
      element.hasPointerCapture(pointerId)
    ) {
      element.releasePointerCapture(pointerId);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    movedRef.current = false;
    const measured = measure?.();
    const startWidth =
      measured !== undefined && measured.width > 0 ? measured.width : width;
    const maxWidth =
      measured !== undefined && measured.maxWidth > 0 ? measured.maxWidth : max;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      maxWidth,
    };
    const element = event.currentTarget;
    // jsdom 没有指针捕获 API；没有它时事件仍会照常派发到元素上。
    if (typeof element.setPointerCapture === 'function') {
      element.setPointerCapture(event.pointerId);
    }
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > DRAG_CLICK_SLOP) {
      movedRef.current = true;
    }
    const next = drag.startWidth + scale * (event.clientX - drag.startX);
    commitWidth(clampWidth(next, drag.maxWidth), drag.startWidth);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    releaseCapture(event.currentTarget, event.pointerId);
    setDragging(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      commitWidth(
        clampWidth(event.key === 'Home' ? min : max, max),
        width,
      );
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const delta = event.key === 'ArrowRight' ? step : -step;
    commitWidth(clampWidth(width + delta, max), width);
  }

  // 指针捕获下浏览器仍会在 pointerup 后合成 click：记录来自拖动的 click，
  // 避免连续两次快速拖动合成 dblclick、把用户调好的宽度复位。
  function handleClick(): void {
    if (movedRef.current) dragClickAtRef.current = Date.now();
  }

  function handleDoubleClick(): void {
    const lastDragClick = dragClickAtRef.current;
    if (
      lastDragClick !== null &&
      Date.now() - lastDragClick < DOUBLE_CLICK_GUARD_MS
    ) {
      dragClickAtRef.current = null;
      return;
    }
    onReset();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clampWidth(width, max)}
      tabIndex={0}
      title="拖动调整正文宽度，双击恢复默认"
      className={styles.handle}
      data-dragging={dragging || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    />
  );
}
