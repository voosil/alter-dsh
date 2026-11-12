/**
 * P2 version-history tools over the real alter authority stack.
 *
 * The tool runs through `createAgentRpcHandler` against a real SQLite runtime,
 * exactly like the Host registers it. Covered here: the bounded metadata
 * listing (author=alter, no snapshot body), the destructive restore gate
 * (approval, rejection, fail-closed without an approval service), the revision
 * CAS and hand-written argument checks.
 */
import { describe, expect, it } from 'vitest';
import { registerVersionTools } from '../../../host/authority/version-tools.js';
import type {
  RpcCall,
  RpcToolDeps,
} from '../../../host/authority/tool-support.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import { approvalStub, runtimeAgentRpc } from '../../support/agent-rpc.js';
import { startRuntime, type TestRuntime } from '../../support/harness.js';
import { dispose } from '../../support/lifecycle.js';

const signal = new AbortController().signal;

interface ToolHarness {
  definitions: Map<string, ToolDefinitionLike>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  render(name: string, args: Record<string, unknown>, value: unknown): string;
}

/** Capture the one tool definition the registrar installs. */
function captureVersionTools(deps: RpcToolDeps): ToolHarness {
  const definitions = new Map<string, ToolDefinitionLike>();
  const tools: ToolsLike = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
  };
  dispose(registerVersionTools(tools, deps));
  return {
    definitions,
    async call(name, args) {
      const definition = definitions.get(name);
      if (definition === undefined)
        throw new Error(`tool ${name} is not registered`);
      return definition.execute(args, {
        callId: `${name}-call`,
        name,
        arguments: args,
        signal,
      });
    },
    render(name, args, value) {
      const definition = definitions.get(name);
      if (definition === undefined)
        throw new Error(`tool ${name} is not registered`);
      return definition.output
        .render(args, value)
        .map((block) => block.text)
        .join('\n');
    },
  };
}

/** The rejected error of a call that must fail. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the tool call to fail');
}

interface VersionView {
  id: string;
  title: string;
  author: string;
  at: string;
  bytes: number;
}

interface VersionListResult {
  doc_id: string;
  total: number;
  truncated: boolean;
  versions: VersionView[];
}

interface RestoreResult {
  doc_id: string;
  version_id: string;
  revision: number;
  changed_block_ids: string[];
}

function asVersionList(result: unknown): VersionListResult {
  return result as VersionListResult;
}

async function docState(
  rpc: RpcCall,
  docId: string,
): Promise<{ revision: number; markdown: string }> {
  return (await rpc('doc.read', [docId])) as {
    revision: number;
    markdown: string;
  };
}

interface VersionFixture {
  runtime: TestRuntime['runtime'];
  rpc: RpcCall;
  tools: ToolHarness;
  docId: string;
}

/**
 * Seed one document with two body writes (two stored versions) and capture the
 * tool over the same alter-bound RPC seam the Host uses.
 */
async function openFixture(
  approval?: RpcToolDeps['approval'],
): Promise<VersionFixture> {
  const { runtime } = await startRuntime();
  const rpc = runtimeAgentRpc(runtime);
  const space = await runtime.agentService.createSpace({
    name: '版本工具测试',
    directories: [],
  });
  const generated = await runtime.agentDocument.generate({
    spaceId: space.id,
    title: '版本文档',
    markdown: '# 标题\n\n第一版正文',
  });
  // A second body write records a second version and advances the revision.
  await runtime.agentDocument.generate({
    docId: generated.docId,
    title: '第二版文档',
    markdown: '第二版追加段落',
  });
  const tools = captureVersionTools(
    approval === undefined ? { rpc } : { rpc, approval },
  );
  return { runtime, rpc, tools, docId: generated.docId };
}

describe('space_versions over the alter authority stack', () => {
  it('lists bounded version metadata authored by alter', async () => {
    const h = await openFixture();
    const listed = asVersionList(
      await h.tools.call('space_versions', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    expect(listed.doc_id).toBe(h.docId);
    expect(listed.total).toBeGreaterThanOrEqual(2);
    expect(listed.truncated).toBe(false);
    for (const version of listed.versions) {
      // id/title/author/at/bytes only — never the snapshot body.
      expect(Object.keys(version).sort()).toEqual([
        'at',
        'author',
        'bytes',
        'id',
        'title',
      ]);
      expect(version.author).toBe('alter');
      expect(version.at).toBeTruthy();
      expect(version.bytes).toBeGreaterThan(0);
    }
    // The raw snapshots carry the AST JSON; the projection must not leak it.
    const raw = await h.runtime.agentService.listVersions(h.docId);
    expect(raw.length).toBe(listed.total);
    expect(raw[0].content).toContain('alter-doc/1');
    expect(JSON.stringify(listed)).not.toContain('alter-doc/1');
    expect(listed.versions.map((version) => version.title).sort()).toEqual([
      '版本文档',
      '第二版文档',
    ]);

    const rendered = h.tools.render(
      'space_versions',
      { action: 'list', doc_id: h.docId },
      listed,
    );
    expect(rendered).toContain('版本历史');
    expect(rendered).toContain('第二版文档');
  });

  it('restores an earlier version after approval and advances the revision', async () => {
    const stub = approvalStub('allowed-once');
    const h = await openFixture(stub.approval);
    const beforeVersions = asVersionList(
      await h.tools.call('space_versions', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const before = await docState(h.rpc, h.docId);
    expect(before.markdown).toContain('第二版追加段落');
    const target = beforeVersions.versions.find(
      (version) => version.title === '版本文档',
    );
    expect(target).toBeDefined();

    const restored = (await h.tools.call('space_versions', {
      action: 'restore',
      doc_id: h.docId,
      version_id: target!.id,
      base_revision: before.revision,
    })) as RestoreResult;
    expect(restored.doc_id).toBe(h.docId);
    expect(restored.version_id).toBe(target!.id);
    expect(restored.revision).toBe(before.revision + 1);
    expect(Array.isArray(restored.changed_block_ids)).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].toolName).toBe('space_versions');
    expect(stub.requests[0].reason).toContain('替换当前正文');

    const after = await docState(h.rpc, h.docId);
    expect(after.revision).toBe(restored.revision);
    expect(after.markdown).toContain('第一版正文');
    expect(after.markdown).not.toContain('第二版追加段落');
    const node = (await h.rpc('space.getNode', [h.docId])) as {
      title: string;
    };
    expect(node.title).toBe('版本文档');

    // The pre-restore body stays recoverable as a new history entry.
    const afterVersions = asVersionList(
      await h.tools.call('space_versions', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    expect(afterVersions.total).toBeGreaterThan(beforeVersions.total);
    expect(
      afterVersions.versions.some(
        (version) => version.title === '第二版文档',
      ),
    ).toBe(true);

    expect(
      h.tools.render(
        'space_versions',
        {
          action: 'restore',
          doc_id: h.docId,
          version_id: target!.id,
          base_revision: before.revision,
        },
        restored,
      ),
    ).toContain('恢复前的正文已保留');
  });

  it('fails closed when the user rejects the restore', async () => {
    const stub = approvalStub('rejected');
    const h = await openFixture(stub.approval);
    const beforeVersions = asVersionList(
      await h.tools.call('space_versions', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const before = await docState(h.rpc, h.docId);
    const target = beforeVersions.versions.find(
      (version) => version.title === '版本文档',
    );
    expect(target).toBeDefined();

    const error = await failure(
      h.tools.call('space_versions', {
        action: 'restore',
        doc_id: h.docId,
        version_id: target!.id,
        base_revision: before.revision,
      }),
    );
    expect(error.message).toContain('未批准');
    expect(stub.requests).toHaveLength(1);

    const after = await docState(h.rpc, h.docId);
    expect(after.revision).toBe(before.revision);
    expect(after.markdown).toContain('第二版追加段落');
  });

  it('fails closed without an approval service', async () => {
    const h = await openFixture();
    const beforeVersions = asVersionList(
      await h.tools.call('space_versions', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const before = await docState(h.rpc, h.docId);
    const target = beforeVersions.versions.find(
      (version) => version.title === '版本文档',
    );
    expect(target).toBeDefined();

    const error = await failure(
      h.tools.call('space_versions', {
        action: 'restore',
        doc_id: h.docId,
        version_id: target!.id,
        base_revision: before.revision,
      }),
    );
    expect(error.message).toContain('审批');
    expect(error.message).toContain('已取消');
    expect((await docState(h.rpc, h.docId)).revision).toBe(before.revision);
  });

  it('rejects a stale base_revision instead of overwriting a newer body', async () => {
    const stub = approvalStub('allowed-once');
    const h = await openFixture(stub.approval);
    const beforeVersions = asVersionList(
      await h.tools.call('space_versions', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const before = await docState(h.rpc, h.docId);
    const target = beforeVersions.versions.find(
      (version) => version.title === '版本文档',
    );
    expect(target).toBeDefined();

    const error = await failure(
      h.tools.call('space_versions', {
        action: 'restore',
        doc_id: h.docId,
        version_id: target!.id,
        base_revision: before.revision - 1,
      }),
    );
    expect(error.message).toContain('doc/conflict');
    const after = await docState(h.rpc, h.docId);
    expect(after.revision).toBe(before.revision);
    expect(after.markdown).toContain('第二版追加段落');
  });

  it('rejects malformed arguments with space/invalid-input', async () => {
    const h = await openFixture();
    const cases: Array<Record<string, unknown>> = [
      { action: 'nope', doc_id: h.docId },
      { action: 'list' },
      { action: 'restore', doc_id: h.docId },
      { action: 'restore', doc_id: h.docId, version_id: 'ver-missing' },
      {
        action: 'restore',
        doc_id: h.docId,
        version_id: 'ver-missing',
        base_revision: '2',
      },
    ];
    for (const args of cases) {
      const error = await failure(h.tools.call('space_versions', args));
      expect(error.message, JSON.stringify(args)).toContain(
        'space/invalid-input',
      );
    }
    const scalar = await failure(
      h.tools.call('space_versions', null as never),
    );
    expect(scalar.message).toContain('space/invalid-input');
  });

  it('declares read concurrency and a generic call card', async () => {
    const h = await openFixture();
    const definition = h.tools.definitions.get('space_versions');
    expect(definition).toBeDefined();
    expect(definition!.isConcurrencySafe?.({ action: 'list' })).toBe(true);
    expect(definition!.isConcurrencySafe?.({ action: 'restore' })).toBe(false);
    expect(definition!.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Document version history',
      kind: 'edit',
    });
    expect(Array.isArray(definition!.parameters.required)).toBe(true);
    expect(definition!.parameters.required).toContain('doc_id');
  });
});