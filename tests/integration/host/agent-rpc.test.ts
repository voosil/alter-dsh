/**
 * Alter-bound RPC seam for the domain tools.
 *
 * The tools added after P1 call named endpoints instead of the narrow typed
 * ports. The seam must keep the same two guarantees the structure tools rely
 * on: the alter identity stack is selected (attribution derives from `alter`),
 * and business failures surface as coded errors. Both authority modes are
 * checked against real state — a real SQLite runtime and a real HTTP server.
 */
import { describe, expect, it } from 'vitest';
import { createRemoteBridge } from '../../../host/remote/bridge.js';
import {
  bridgeAgentRpc,
  runtimeAgentRpc,
} from '../../support/agent-rpc.js';
import { startRuntime, startTestServer, TEST_TOKEN } from '../../support/harness.js';
import { dispose, quietLogger, tempDir } from '../../support/lifecycle.js';

interface SpaceRow {
  id: string;
}

interface ThoughtRow {
  id: string;
  creator: string;
}

interface CommentRow {
  id: string;
  author: string;
}

describe('alter-bound endpoint seam', () => {
  it('runs reads and writes on the local alter stack and codes failures', async () => {
    const { runtime } = await startRuntime();
    const rpc = runtimeAgentRpc(runtime);

    const spaces = (await rpc('space.listSpaces', [])) as SpaceRow[];
    expect(spaces.length).toBeGreaterThan(0);
    const spaceId = spaces[0]!.id;

    const thought = (await rpc('space.createThought', [
      { spaceId, content: '来自 Agent 的随想' },
    ])) as ThoughtRow;
    expect(thought.creator).toBe('alter');

    const generated = (await rpc('doc.generate', [
      { spaceId, title: 'RPC 自检', markdown: '# 自检\n\n正文' },
    ])) as { docId: string };
    const comment = (await rpc('space.addComment', [
      { docId: generated.docId, body: 'Agent 评论' },
    ])) as CommentRow;
    expect(comment.author).toBe('alter');

    // Unknown endpoints become the same coded error the tools map.
    await expect(rpc('space.notARealMethod', [])).rejects.toMatchObject({
      code: 'space/not-found',
    });
  });

  it('exposes the same seam through the bridge and stamps alter across the hop', async () => {
    const server = await startTestServer();
    dispose(() => server.close());
    const directory = await tempDir('space-agent-rpc-');
    const bridge = createRemoteBridge({
      baseUrl: server.url,
      token: TEST_TOKEN,
      directory,
      logger: quietLogger(),
    });
    dispose(() => bridge.close());
    await bridge.refresh();
    const rpc = bridgeAgentRpc(bridge);

    const spaces = (await rpc('space.listSpaces', [])) as SpaceRow[];
    expect(spaces.length).toBeGreaterThan(0);
    const spaceId = spaces[0]!.id;

    const thought = (await rpc('space.createThought', [
      { spaceId, content: '服务端随想' },
    ])) as ThoughtRow;
    expect(thought.creator).toBe('alter');

    await expect(rpc('space.notARealMethod', [])).rejects.toMatchObject({
      code: 'space/not-found',
    });
  });
});