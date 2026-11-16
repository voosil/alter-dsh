import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from 'react';

/**
 * 正文栏宽度（行宽）的本地偏好。
 *
 * 文档页的正文栏是居中列：宽度属于只存在浏览器的阅读偏好，落在 localStorage，
 * 不进 Host/SQLite（业务数据边界见 `docs/specs/system-architecture.md`）。
 * 未拖动过时偏好为 null，页面保持 token 默认宽度，静息视觉与改造前一致。
 */
export const DOC_WIDTH_KEY = 'alter.space.docWidth';

/**
 * token 默认宽度（px），只在无法量出真实布局时兜底（jsdom 测试、首帧）。
 * 与 `vendor/ui-system/src/styles/tokens.css` 的 `--alter-doc-width` 保持一致；
 * 未拖动过时页面不写内联变量，实际宽度始终来自 token。
 */
export const DEFAULT_DOC_WIDTH = 760;

/** 可拖动的最小行宽，约 35 个汉字/行。 */
export const MIN_DOC_WIDTH = 560;

/** 可拖动的最大行宽，约 70 个汉字/行；实际还受正文栏可用宽度约束。 */
export const MAX_DOC_WIDTH = 1120;

/** 正文栏两侧各留出的边缘：手柄落在栏内，不压到滚动条或评论轨。 */
export const DOC_EDGE_GUTTER = 12;

/** 评论轨开合会带动网格过渡，结束后再重测一次可用宽度。 */
const REFLOW_DELAY_MS = 260;

/** 行宽至少要有这么可调，拖动才有意义；否则隐藏手柄。 */
const MIN_RESIZE_SPAN = 40;

/** 正文栏的实测结果；`columnWidth` 为 0 表示当前环境量不出布局。 */
export interface DocWidthMetrics {
  /** 正文栏当前渲染宽度（px）。 */
  width: number;
  /** 正文栏所在网格轨道的可用宽度（px），含左右居中留白。 */
  columnWidth: number;
  /** 拖动可达的上限：可用宽度留出两侧边缘后与 `MAX_DOC_WIDTH` 取小。 */
  maxWidth: number;
  /** 窄布局已把正文栏改为全宽（CSS `max-width: none`）。 */
  collapsed: boolean;
}

const UNMEASURED: DocWidthMetrics = {
  width: 0,
  columnWidth: 0,
  maxWidth: MAX_DOC_WIDTH,
  collapsed: false,
};

/** 把宽度收敛到 [MIN_DOC_WIDTH, max] 区间。 */
export function clampDocWidth(
  value: number,
  max: number = MAX_DOC_WIDTH,
): number {
  const upper = Math.min(MAX_DOC_WIDTH, Math.max(MIN_DOC_WIDTH, max));
  if (!Number.isFinite(value)) return MIN_DOC_WIDTH;
  return Math.min(upper, Math.max(MIN_DOC_WIDTH, Math.round(value)));
}

function readStoredDocWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(DOC_WIDTH_KEY);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? clampDocWidth(parsed) : null;
  } catch {
    return null;
  }
}

function storeDocWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(DOC_WIDTH_KEY);
    else window.localStorage.setItem(DOC_WIDTH_KEY, String(width));
  } catch {
    // 本地偏好是尽力而为：隐私模式等写不进去时只影响记忆，不影响拖动。
  }
}

/**
 * 量出正文栏当前宽度与可用上限。
 *
 * 正文栏用 `margin: auto` 居中，浏览器把 auto 解析成实际像素，因此
 * `rect.width + 左右 margin` 就是它所在网格轨道的宽度；量不出布局
 * （宽度为 0）时返回 `UNMEASURED`，调用方按“未折叠、上限取 MAX”处理。
 */
export function measureDocWidth(paper: HTMLElement | null): DocWidthMetrics {
  if (paper === null) return UNMEASURED;
  const rect = paper.getBoundingClientRect();
  if (rect.width <= 0) return UNMEASURED;
  const style = getComputedStyle(paper);
  const margin = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const columnWidth = Math.round(
    rect.width + margin(style.marginLeft) + margin(style.marginRight),
  );
  return {
    width: Math.round(rect.width),
    columnWidth,
    maxWidth: Math.min(
      MAX_DOC_WIDTH,
      Math.max(MIN_DOC_WIDTH, columnWidth - 2 * DOC_EDGE_GUTTER),
    ),
    collapsed: style.maxWidth === 'none',
  };
}

/** 指标不变时不重渲染：ResizeObserver 首次观察与窗口 resize 都会重复回调。 */
function sameMetrics(a: DocWidthMetrics, b: DocWidthMetrics): boolean {
  return (
    a.width === b.width &&
    a.columnWidth === b.columnWidth &&
    a.maxWidth === b.maxWidth &&
    a.collapsed === b.collapsed
  );
}

/**
 * 跟随窗口、页面容器与评论轨变化重测正文栏指标。
 *
 * @param paperRef - 正文栏（`.paper`）元素。
 * @param reflowKey - 改变网格轨道但不会改变容器尺寸的状态（如评论轨开合）。
 */
export function useDocWidthMetrics(
  paperRef: RefObject<HTMLElement | null>,
  reflowKey: unknown,
): DocWidthMetrics {
  const [metrics, setMetrics] = useState<DocWidthMetrics>(UNMEASURED);

  const measure = useCallback(() => {
    setMetrics((previous) => {
      const next = measureDocWidth(paperRef.current);
      return sameMetrics(previous, next) ? previous : next;
    });
  }, [paperRef]);

  useLayoutEffect(() => {
    const element = paperRef.current;
    measure();
    window.addEventListener('resize', measure);
    if (element === null || typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', measure);
    }
    // 正文栏宽度受页面容器（侧边栏拖动、窗口缩放）与评论轨开合影响；
    // 两者都可能只改变居中留白而不改变正文栏自身宽度，因此同时观察父容器。
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement !== null) observer.observe(element.parentElement);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, paperRef]);

  useEffect(() => {
    // 网格列有 220ms 过渡；结束前量到的是旧轨道，过渡结束再补一次。
    const timer = window.setTimeout(measure, REFLOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [measure, reflowKey]);

  return metrics;
}

/** 正文栏宽度是否允许拖动（手柄的渲染条件）。 */
export function canResizeDocWidth(metrics: DocWidthMetrics): boolean {
  if (metrics.collapsed) return false;
  if (metrics.columnWidth === 0) return true;
  return metrics.maxWidth - MIN_DOC_WIDTH > MIN_RESIZE_SPAN;
}

/**
 * 正文栏宽度偏好：`width` 为 null 时使用 token 默认值。
 *
 * 拖动过程中每次变化都写本地存储（与目录宽度一致的做法）；量不出的环境
 * （测试）同样按 `clampDocWidth` 收敛到常量范围。
 */
export function useDocWidth(): {
  width: number | null;
  resize: (next: number) => void;
  reset: () => void;
} {
  const [width, setWidth] = useState<number | null>(readStoredDocWidth);

  useEffect(() => {
    storeDocWidth(width);
  }, [width]);

  const resize = useCallback((next: number) => {
    setWidth(clampDocWidth(next));
  }, []);

  const reset = useCallback(() => setWidth(null), []);

  return { width, resize, reset };
}
