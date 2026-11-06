import { useCallback, useEffect, useState } from 'react';

export const SIDEBAR_WIDTH_KEY = 'alter.space.sidebarWidth';
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 440;
const MAX_VIEWPORT_RATIO = 0.45;

export function clampSidebarWidth(
  value: number,
  viewportWidth = window.innerWidth,
) {
  const max = Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.round(viewportWidth * MAX_VIEWPORT_RATIO),
  );
  const min = Math.min(MIN_SIDEBAR_WIDTH, max);
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredWidth() {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!stored) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

function storeWidth(width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    else window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // Local persistence is best-effort in the mock.
  }
}

/**
 * 目录宽度：未拖动过时返回 null，由样式中的默认宽度决定；
 * 拖动后记录像素值并在窗口变窄时收回到可视范围内。
 */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number | null>(readStoredWidth);

  useEffect(() => {
    storeWidth(width);
  }, [width]);

  useEffect(() => {
    function handleResize() {
      setWidth((current) =>
        current === null ? current : clampSidebarWidth(current),
      );
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const resize = useCallback((next: number) => {
    setWidth(clampSidebarWidth(next));
  }, []);

  const reset = useCallback(() => setWidth(null), []);

  return { width, resize, reset };
}
