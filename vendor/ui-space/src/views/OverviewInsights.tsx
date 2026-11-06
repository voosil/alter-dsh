import { Gauge, Sparkles } from 'lucide-react';
import { Button } from '@alter/ui-system';
import { useHub, useHubAction } from '../hub/context';
import { useSpaceContext } from '../runtime';
import { formatRelativeTime } from '../utils/date';
import styles from './OverviewInsights.module.css';

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function SpaceSummary() {
  const hub = useHub();
  const { service, spaceId } = useSpaceContext();
  const action = useHubAction();
  const content = hub.summary.content;
  return (
    <section className={styles.panel} aria-labelledby="overview-summary">
      <div className={styles.head}>
        <div className={styles.kicker}>
          <Sparkles size={14} aria-hidden="true" />
          <h2 id="overview-summary">Alter 的总结</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className={styles.action}
          disabled={action.busy}
          onClick={() => void action.run(() => service.hub.summarize(spaceId))}
        >
          {action.busy ? '正在总结…' : content ? '重新总结' : '生成总结'}
        </Button>
      </div>
      {content ? (
        <p className={styles.summary}>{content}</p>
      ) : (
        <p className={styles.empty}>还没有可总结的进展。留下一些记录后再试。</p>
      )}
      <p className={styles.note}>
        {hub.summary.updatedAt
          ? `更新于 ${formatRelativeTime(hub.summary.updatedAt)}`
          : '尚未生成'}
      </p>
      {action.error ? (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      ) : null}
    </section>
  );
}

export function SpaceUsage() {
  const hub = useHub();
  const usage = hub.usage;
  const input = usage.reduce((sum, row) => sum + row.inputTokens, 0);
  const output = usage.reduce((sum, row) => sum + row.outputTokens, 0);
  const cached = usage.reduce((sum, row) => sum + row.cachedTokens, 0);
  const total = input + output;
  const rate = input ? cached / input : 0;
  const days = new Set(usage.map((row) => row.date)).size;
  const models = new Map<string, number>();
  for (const row of usage) {
    models.set(
      row.model,
      (models.get(row.model) ?? 0) + row.inputTokens + row.outputTokens,
    );
  }
  const modelList = [...models.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <section
      className={`${styles.panel} ${styles.usage}`}
      aria-labelledby="overview-usage"
    >
      <div className={styles.head}>
        <div className={styles.kicker}>
          <Gauge size={14} aria-hidden="true" />
          <h2 id="overview-usage">用量</h2>
        </div>
        <span className={styles.note}>
          {days ? `近 ${days} 天` : '暂无记录'}
        </span>
      </div>
      {usage.length ? (
        <div className={styles.usageBody}>
          <div>
            <dl className={styles.metrics}>
              <div>
                <dt>总 Token</dt>
                <dd>{formatTokens(total)}</dd>
              </div>
              <div>
                <dt>缓存命中</dt>
                <dd>{Math.round(rate * 100)}%</dd>
              </div>
            </dl>
            <p className={styles.sub}>
              输入 {formatTokens(input)} · 输出 {formatTokens(output)}
            </p>
          </div>
          <div className={styles.models}>
            <h3>模型</h3>
            <ul>
              {modelList.map(([name, tokens]) => (
                <li key={name}>
                  <span>{name}</span>
                  <span>
                    {formatTokens(tokens)} ·{' '}
                    {Math.round((tokens / total) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className={styles.empty}>这个空间还没有模型调用记录。</p>
      )}
    </section>
  );
}
