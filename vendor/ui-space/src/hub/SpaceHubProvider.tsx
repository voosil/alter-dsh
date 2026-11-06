import { useEffect, useState, type ReactNode } from 'react';
import type { HubSnapshot } from '@alter/protocol';
import { Button } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { HubContext } from './context';
export function SpaceHubProvider({ children }: { children: ReactNode }) {
  const { service, spaceId, version } = useSpaceContext();
  const [result, setResult] = useState<{ id: string; data: HubSnapshot }>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void service.hub
      .get(spaceId)
      .then((data) => {
        if (active) {
          setResult({ id: spaceId, data });
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : '空间信息未能加载');
      });
    return () => {
      active = false;
    };
  }, [service, spaceId, version, retry]);
  if (error)
    return (
      <div role="alert">
        <p>{error}</p>
        <Button onClick={() => setRetry((value) => value + 1)}>重新加载</Button>
      </div>
    );
  if (!result || result.id !== spaceId)
    return <p role="status">正在打开空间…</p>;
  return (
    <HubContext.Provider value={result.data}>{children}</HubContext.Provider>
  );
}
