import { useEffect, useRef, useState } from 'react';
import { Folder, RotateCw } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Button } from '@alter/ui-system';
import type { TerminalService } from '@alter/protocol';
import type { WorkbenchTab } from './store';
import '@xterm/xterm/css/xterm.css';
import styles from './Workbench.module.css';

export function TerminalView({
  service,
  tab,
  active,
}: {
  service: TerminalService;
  tab: WorkbenchTab;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  const [directory, setDirectory] = useState(tab.directory ?? '');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在连接终端…');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    activeRef.current = active;
    if (active) requestAnimationFrame(() => terminalRef.current?.focus());
  }, [active]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let ready = false;
    let timer = 0;
    let frame = 0;
    let offset = 0;
    let inputQueue = Promise.resolve();
    const palette = getComputedStyle(host);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: `"JetBrainsMono Nerd Font Mono", "JetBrainsMonoNL Nerd Font Mono", "Symbols Nerd Font Mono", ${palette.getPropertyValue('--alter-font-mono').trim() || 'monospace'}`,
      lineHeight: 1.25,
      scrollback: 5000,
      screenReaderMode: true,
      theme: {
        background: palette.getPropertyValue('--alter-surface-raised').trim(),
        foreground: palette.getPropertyValue('--alter-text-secondary').trim(),
        cursor: palette.getPropertyValue('--alter-text-secondary').trim(),
        selectionBackground: palette
          .getPropertyValue('--alter-control-border')
          .trim(),
      },
    });
    terminalRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.textarea?.setAttribute('aria-label', '终端输入');
    function fail(cause: unknown) {
      if (cancelled) return;
      setError(
        cause instanceof Error && cause.message !== 'Internal server error'
          ? cause.message
          : '终端暂时不可用，请检查宿主连接后重试。',
      );
      setStatus('连接中断');
      ready = false;
    }
    function resize() {
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
      const size = fit.proposeDimensions();
      if (!size) return;
      const cols = Math.max(10, Math.min(500, size.cols));
      const rows = Math.max(2, Math.min(300, size.rows));
      if (cols === term.cols && rows === term.rows) return;
      term.resize(cols, rows);
      if (ready) void service.resize(tab.id, cols, rows).catch(fail);
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(host);
    resize();
    const input = term.onData((data) => {
      if (!ready) return;
      inputQueue = inputQueue
        .then(async () => {
          for (let index = 0; index < data.length && !cancelled; index += 8192)
            await service.write(tab.id, data.slice(index, index + 8192));
        })
        .catch(fail);
    });
    async function poll() {
      if (cancelled || !ready) return;
      try {
        const result = await service.read(tab.id, offset);
        if (cancelled) return;
        if (result.truncated)
          term.writeln('\r\n[较早的终端输出已超出保留范围]\r\n');
        offset = result.offset;
        if (result.data)
          await new Promise<void>((resolve) =>
            term.write(result.data, resolve),
          );
        if (cancelled) return;
        if (result.error) {
          fail(new Error(result.error));
          return;
        }
        if (result.exited) {
          ready = false;
          setStatus(
            `进程已退出${result.exitCode === null ? '' : `（${result.exitCode}）`}`,
          );
          return;
        }
        timer = window.setTimeout(
          () => void poll(),
          activeRef.current ? 80 : 500,
        );
      } catch (cause) {
        fail(cause);
      }
    }
    setError('');
    setStatus('正在连接终端…');
    void service
      .open({
        id: tab.id,
        directory: tab.directory ?? '',
        cols: term.cols,
        rows: term.rows,
      })
      .then((session) => {
        if (cancelled) return;
        setDirectory(session.directory);
        setStatus('已连接');
        ready = true;
        resize();
        if (activeRef.current) term.focus();
        void poll();
      })
      .catch(fail);
    return () => {
      cancelled = true;
      ready = false;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      input.dispose();
      observer.disconnect();
      terminalRef.current = null;
      term.dispose();
    };
  }, [service, tab.id, tab.directory, revision]);
  return (
    <div className={styles.terminal}>
      <div className={styles.context}>
        <Folder size={14} />
        <span title={directory}>{directory}</span>
        <span className={styles.terminalStatus} role="status">
          {status}
        </span>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {error || status.startsWith('进程已退出') ? (
        <div className={styles.terminalRetry}>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await service.close(tab.id);
                setRevision((value) => value + 1);
              } catch {
                setError('无法关闭旧会话，请检查宿主连接后重试。');
              }
            }}
          >
            <RotateCw size={14} />
            重新连接
          </Button>
        </div>
      ) : null}
      <div
        ref={hostRef}
        className={styles.terminalSurface}
        role="region"
        aria-label="终端会话"
      />
    </div>
  );
}
