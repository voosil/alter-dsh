import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, LocateFixed, Minus, Plus, X } from 'lucide-react';
import type { Journey } from '@alter/protocol';
import { Button, IconButton } from '@alter/ui-system';
import { dateText } from './context';
import styles from './JourneyCanvas.module.css';

type Camera = { x: number; y: number; scale: number };
const labels = {
  past: '走过',
  failed: '一次岔路',
  current: '现在',
  future: '下一程',
};
export function JourneyCanvas({
  nodes,
  onOpenMatter,
}: {
  nodes: Journey['nodes'];
  onOpenMatter: (id: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const points = nodes.map((node, index) => ({
    ...node,
    x: 150 + index * 260,
    y:
      node.state === 'failed'
        ? 345
        : node.state === 'future'
          ? 170
          : index % 2
            ? 225
            : 205,
  }));
  const currentIndex = Math.max(
    0,
    nodes.findIndex((node) => node.state === 'current'),
  );
  const currentX = 150 + currentIndex * 260;
  const sceneWidth = Math.max(1000, nodes.length * 260 + 120);
  const selectedNode = points.find((node) => node.id === selected);
  function home() {
    const width = viewport.current?.clientWidth ?? 700;
    const height = viewport.current?.clientHeight ?? 560;
    setCamera({
      x: width / 2 - currentX,
      y: height * 0.36 - (points[currentIndex]?.y ?? 205),
      scale: 1,
    });
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      const scale =
        width < 520 ? 1 : Math.max(0.7, Math.min(1, width / (sceneWidth - 60)));
      setCamera({
        x:
          width < 520
            ? width / 2 - currentX
            : (width - (sceneWidth - 80) * scale) / 2,
        y: width < 520 ? element.clientHeight * 0.36 - 205 : 24,
        scale,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [currentX, sceneWidth]);
  function bounded(next: Camera): Camera {
    const width = viewport.current?.clientWidth ?? 700;
    return {
      ...next,
      x: Math.max(80 - sceneWidth * next.scale, Math.min(width - 80, next.x)),
      y: Math.max(-240, Math.min(200, next.y)),
    };
  }
  function zoom(delta: number) {
    const width = viewport.current?.clientWidth ?? 700;
    setCamera((old) => {
      const scale = Math.max(
        0.6,
        Math.min(1.4, Math.round((old.scale + delta) * 10) / 10),
      );
      const ratio = scale / old.scale;
      return bounded({
        x: width / 2 - (width / 2 - old.x) * ratio,
        y:
          (viewport.current?.clientHeight ?? 560) * 0.36 -
          ((viewport.current?.clientHeight ?? 560) * 0.36 - old.y) * ratio,
        scale,
      });
    });
  }
  const main = points.filter((node) => node.state !== 'failed');
  function path(from: { x: number; y: number }, to: { x: number; y: number }) {
    const middle = (from.x + to.x) / 2;
    return `M${from.x},${from.y} C${middle},${from.y} ${middle},${to.y} ${to.x},${to.y}`;
  }
  return (
    <div className={styles.frame}>
      <div
        ref={viewport}
        className={styles.canvas}
        data-dragging={dragging || undefined}
        role="region"
        aria-label="旅程画布"
        aria-describedby="journey-canvas-help"
        tabIndex={0}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as HTMLElement).closest('button')
          )
            return;
          drag.current = { x: event.clientX, y: event.clientY, camera };
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setCamera(
            bounded({
              ...drag.current.camera,
              x: drag.current.camera.x + event.clientX - drag.current.x,
              y:
                event.pointerType === 'touch'
                  ? drag.current.camera.y
                  : drag.current.camera.y + event.clientY - drag.current.y,
            }),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            const [dx, dy] = {
              ArrowLeft: [60, 0],
              ArrowRight: [-60, 0],
              ArrowUp: [0, 60],
              ArrowDown: [0, -60],
            }[event.key]!;
            setCamera((old) =>
              bounded({ ...old, x: old.x + dx!, y: old.y + dy! }),
            );
          } else if (event.key === 'Home') {
            event.preventDefault();
            home();
          } else if (event.key === '+' || event.key === '=') zoom(0.1);
          else if (event.key === '-') zoom(-0.1);
        }}
      >
        <div
          className={styles.scene}
          style={{
            width: sceneWidth,
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          }}
        >
          <svg
            width={sceneWidth}
            height="500"
            aria-hidden="true"
            className={styles.paths}
          >
            {main.slice(1).map((node, index) => (
              <path
                key={node.id}
                d={path(main[index]!, node)}
                data-future={node.state === 'future' || undefined}
              />
            ))}
            {points
              .filter((node) => node.state === 'failed')
              .map((node) => {
                const previous = points
                  .slice(0, points.indexOf(node))
                  .reverse()
                  .find((point) => point.state !== 'failed');
                return previous ? (
                  <path
                    key={node.id}
                    d={path(previous, node)}
                    className={styles.branch}
                  />
                ) : null;
              })}
          </svg>
          {points.map((node) => (
            <Button
              key={node.id}
              className={styles.node}
              data-state={node.state}
              aria-label={node.title}
              aria-expanded={selected === node.id}
              style={{
                left: node.x,
                top: node.y,
                transform: `translate(-50%, -17px) scale(${1 / camera.scale})`,
                transformOrigin: '50% 17px',
              }}
              onFocus={(event) => {
                if (event.currentTarget.matches(':focus-visible')) {
                  const width = viewport.current?.clientWidth ?? 700;
                  setCamera((old) => ({
                    ...old,
                    x: width / 2 - node.x * old.scale,
                    y:
                      (viewport.current?.clientHeight ?? 560) * 0.36 -
                      node.y * old.scale,
                  }));
                }
              }}
              onClick={() =>
                setSelected(selected === node.id ? undefined : node.id)
              }
            >
              <span className={styles.date}>{dateText(node.date)}</span>
              <span className={styles.marker} aria-hidden="true" />
              <span className={styles.nodeTitle}>{node.title}</span>
              <span className={styles.phase}>{labels[node.state]}</span>
            </Button>
          ))}
        </div>
      </div>
      <p className={styles.help} id="journey-canvas-help">
        拖动浏览 · 点击节点回看经历
      </p>
      {selectedNode ? (
        <aside className={styles.detail} aria-label="旅程节点详情">
          <div className={styles.detailHead}>
            <strong>{selectedNode.title}</strong>
            <IconButton
              label="收起节点详情"
              icon={<X size={14} />}
              onClick={() => setSelected(undefined)}
            />
          </div>
          <p>{selectedNode.detail}</p>
          {selectedNode.matterId ? (
            <Button
              size="sm"
              onClick={() => onOpenMatter(selectedNode.matterId!)}
            >
              查看相关事项
              <ArrowUpRight size={13} aria-hidden="true" />
            </Button>
          ) : null}
        </aside>
      ) : null}
      <div className={styles.controls} aria-label="旅程视图控制">
        <IconButton
          label="缩小旅程"
          icon={<Minus size={15} />}
          disabled={camera.scale <= 0.6}
          onClick={() => zoom(-0.1)}
        />
        <span aria-live="polite">{Math.round(camera.scale * 100)}%</span>
        <IconButton
          label="放大旅程"
          icon={<Plus size={15} />}
          disabled={camera.scale >= 1.4}
          onClick={() => zoom(0.1)}
        />
        <IconButton
          label="回到现在"
          onClick={home}
          icon={<LocateFixed size={16} />}
        />
      </div>
    </div>
  );
}
