import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkbenchController } from './store';
export function useWorkbench(controller: WorkbenchController, key: string) {
  return useSyncExternalStore(controller.subscribe, () =>
    controller.getScope(key),
  );
}

export function useWorkbenchLayout() {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const defaultWidth = window.innerWidth * 0.5;
  const maxWidth = Math.max(Math.min(width, defaultWidth), width - 280);
  const panelWidth = Math.min(
    width,
    ratio === null
      ? defaultWidth
      : Math.max(280, Math.min(maxWidth, width * ratio)),
  );
  return {
    layoutRef,
    width,
    compact: width < 720,
    panelWidth,
    maxWidth,
    resize: (value: number) =>
      setRatio(Math.max(280, Math.min(maxWidth, value)) / Math.max(width, 1)),
    resetWidth: () => setRatio(null),
  };
}
