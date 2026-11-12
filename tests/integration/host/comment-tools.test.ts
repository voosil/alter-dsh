/**
 * P2 comment tools over the real alter authority stack.
 *
 * The same registrations the Host installs run against a real SQLite runtime
 * through `createAgentRpcHandler`; the approval service is the only double.
 * Covered here: the full comment lifecycle, alter attribution, the bounded
 * read projection, the destructive-delete approval gate (allow, reject and
 * fail-closed without any approval service) and hand-written argument checks.
 */
import { describe, expect, it } from 'vitest';
import { registerCommentTools } from '../../../host/authority/comment-tools.js';
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
function captureCommentTools(deps: RpcToolDeps): ToolHarness {
  const definitions = new Map<string, ToolDefinitionLike>();
  const tools: ToolsLike = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
  };
  dispose(registerCommentTools(tools, deps));
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

interface AnchorView {
  block_id: string;
  offset: number;
  length: number;
}

interface CommentView {
  id: string;
  doc_id: string;
  author: string;
  body: string;
  quote: string | null;
  anchor: AnchorView | null;
  status: string;
  supplements_count: number;
  created_at: string;
  resolved_at: string | null;
  deleted_at: string | null;
  edited_at: string | null;
}

interface CommentResult {
  comment: CommentView;
}

interface CommentListResult {
  doc_id: string;
  total: number;
  truncated: boolean;
  comments: CommentView[];
}

function asComment(result: unknown): CommentView {
  return (result as CommentResult).comment;
}

function asList(result: unknown): CommentListResult {
  return result as CommentListResult;
}

interface CommentFixture {
  runtime: TestRuntime['runtime'];
  rpc: RpcCall;
  tools: ToolHarness;
  docId: string;
  blockId: string;
}

/** Open the real runtime, seed one document and capture the tool over it. */
async function openFixture(
  approval?: RpcToolDeps['approval'],
): Promise<CommentFixture> {
  const { runtime } = await startRuntime();
  const rpc = runtimeAgentRpc(runtime);
  const space = await runtime.agentService.createSpace({
    name: '评论工具测试',
    directories: [],
  });
  const generated = await runtime.agentDocument.generate({
    spaceId: space.id,
    title: '评论文档',
    markdown: '# 标题\n\n评论工具覆盖的正文段落。',
  });
  const outline = await runtime.agentDocument.outline(generated.docId);
  const blockId = outline.outline[0].id;
  const tools = captureCommentTools(
    approval === undefined ? { rpc } : { rpc, approval },
  );
  return { runtime, rpc, tools, docId: generated.docId, blockId };
}

describe('space_comments over the alter authority stack', () => {
  it('adds, lists, updates, supplements and resolves comments attributed to alter', async () => {
    const h = await openFixture();
    const anchor = { block_id: h.blockId, offset: 0, length: 4 };

    const added = asComment(
      await h.tools.call('space_comments', {
        action: 'add',
        doc_id: h.docId,
        body: '这一段需要补充论据',
        quote: '正文段落',
        anchor,
      }),
    );
    expect(added.author).toBe('alter');
    expect(added.doc_id).toBe(h.docId);
    expect(added.status).toBe('open');
    expect(added.body).toBe('这一段需要补充论据');
    expect(added.quote).toBe('正文段落');
    expect(added.anchor).toEqual(anchor);
    expect(added.supplements_count).toBe(0);
    expect(added.created_at).toBeTruthy();
    expect(added.resolved_at).toBeNull();
    expect(added.deleted_at).toBeNull();

    // The Host stored the snake_case anchor under the protocol's blockId field.
    const stored = await h.runtime.agentService.listComments(h.docId);
    expect(stored).toHaveLength(1);
    expect(stored[0].author).toBe('alter');
    expect(stored[0].anchor).toEqual({
      blockId: h.blockId,
      offset: 0,
      length: 4,
    });

    // A comment written by the user entrance keeps its own attribution.
    await h.runtime.service.addComment({
      docId: h.docId,
      body: '用户的评论',
    });
    const listed = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    expect(listed.doc_id).toBe(h.docId);
    expect(listed.total).toBe(2);
    expect(listed.truncated).toBe(false);
    expect(listed.comments.map((comment) => comment.author).sort()).toEqual([
      'alter',
      'me',
    ]);
    const listedOwn = listed.comments.find(
      (comment) => comment.id === added.id,
    );
    expect(listedOwn).toBeDefined();
    expect(listedOwn!.anchor).toEqual(anchor);
    expect(listedOwn!.supplements_count).toBe(0);

    const updated = asComment(
      await h.tools.call('space_comments', {
        action: 'update',
        comment_id: added.id,
        body: '改写后的评论',
      }),
    );
    expect(updated.body).toBe('改写后的评论');
    expect(updated.edited_at).not.toBeNull();
    expect(updated.status).toBe('open');

    // An anchor update goes through the same block_id → blockId mapping.
    const reanchored = asComment(
      await h.tools.call('space_comments', {
        action: 'update',
        comment_id: added.id,
        anchor: { block_id: h.blockId, offset: 2, length: 3 },
      }),
    );
    expect(reanchored.anchor).toEqual({
      block_id: h.blockId,
      offset: 2,
      length: 3,
    });

    const supplemented = asComment(
      await h.tools.call('space_comments', {
        action: 'supplement',
        comment_id: added.id,
        body: '补充说明',
      }),
    );
    expect(supplemented.supplements_count).toBe(1);
    expect(supplemented.status).toBe('open');

    const resolved = asComment(
      await h.tools.call('space_comments', {
        action: 'resolve',
        comment_id: added.id,
      }),
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();

    const afterResolve = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    expect(
      afterResolve.comments.find((comment) => comment.id === added.id)?.status,
    ).toBe('resolved');
    expect(afterResolve.comments).toHaveLength(2);
  });

  it('bounds the comment projection: bodies clipped, listing capped at 50', async () => {
    const h = await openFixture();
    const longBody = `长评论 ${'x'.repeat(400)}`;
    for (let index = 0; index < 55; index += 1)
      await h.rpc('space.addComment', [
        { docId: h.docId, body: `${longBody}-${index}` },
      ]);

    const listed = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    expect(listed.total).toBe(55);
    expect(listed.truncated).toBe(true);
    expect(listed.comments).toHaveLength(50);
    for (const comment of listed.comments) {
      expect(comment.body.length).toBe(300);
      // The raw supplements array and unknown fields never cross over.
      expect(Object.keys(comment).sort()).toEqual([
        'anchor',
        'author',
        'body',
        'created_at',
        'deleted_at',
        'doc_id',
        'edited_at',
        'id',
        'quote',
        'resolved_at',
        'status',
        'supplements_count',
      ]);
    }
    const rendered = h.tools.render(
      'space_comments',
      { action: 'list', doc_id: h.docId },
      listed,
    );
    expect(rendered).toContain('共 55 条评论');
    expect(rendered).toContain('truncated');
  });

  it('deletes a comment only after approval and keeps a readable tombstone', async () => {
    const stub = approvalStub('allowed-once');
    const h = await openFixture(stub.approval);
    const added = asComment(
      await h.tools.call('space_comments', {
        action: 'add',
        doc_id: h.docId,
        body: '待删除的评论',
      }),
    );

    const deleted = (await h.tools.call('space_comments', {
      action: 'delete',
      comment_id: added.id,
    })) as { deleted: boolean; comment_id: string; status: string };
    expect(deleted).toEqual({
      deleted: true,
      comment_id: added.id,
      status: 'deleted',
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].toolName).toBe('space_comments');
    expect(stub.requests[0].reason).toContain('不可恢复');

    const listed = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const tombstone = listed.comments.find(
      (comment) => comment.id === added.id,
    );
    expect(tombstone).toBeDefined();
    expect(tombstone!.status).toBe('deleted');
    expect(tombstone!.deleted_at).not.toBeNull();
    // The tombstone keeps its content in the history view.
    expect(tombstone!.body).toBe('待删除的评论');

    expect(
      h.tools.render(
        'space_comments',
        { action: 'delete', comment_id: added.id },
        deleted,
      ),
    ).toContain('墓碑');
  });

  it('fails closed when the user rejects the destructive delete', async () => {
    const stub = approvalStub('rejected');
    const h = await openFixture(stub.approval);
    const added = asComment(
      await h.tools.call('space_comments', {
        action: 'add',
        doc_id: h.docId,
        body: '不应被删除的评论',
      }),
    );

    const error = await failure(
      h.tools.call('space_comments', {
        action: 'delete',
        comment_id: added.id,
      }),
    );
    expect(error.message).toContain('未批准');
    expect(stub.requests).toHaveLength(1);

    const listed = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const untouched = listed.comments.find(
      (comment) => comment.id === added.id,
    );
    expect(untouched!.status).toBe('open');
    expect(untouched!.deleted_at).toBeNull();
  });

  it('fails closed without an approval service', async () => {
    const h = await openFixture();
    const added = asComment(
      await h.tools.call('space_comments', {
        action: 'add',
        doc_id: h.docId,
        body: '没有审批服务时的评论',
      }),
    );

    const error = await failure(
      h.tools.call('space_comments', {
        action: 'delete',
        comment_id: added.id,
      }),
    );
    expect(error.message).toContain('审批');
    expect(error.message).toContain('已取消');

    const listed = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    expect(
      listed.comments.find((comment) => comment.id === added.id)?.status,
    ).toBe('open');
  });

  it('maps unknown comment ids to an actionable failure', async () => {
    const stub = approvalStub('allowed-once');
    const h = await openFixture(stub.approval);
    const error = await failure(
      h.tools.call('space_comments', {
        action: 'resolve',
        comment_id: 'cm-missing',
      }),
    );
    expect(error.message).toContain('space/failed');
    expect(error.message).toContain('space_comments list');
  });

  it('rejects malformed arguments with space/invalid-input', async () => {
    const h = await openFixture();
    const cases: Array<Record<string, unknown>> = [
      { action: 'nope' },
      { action: 'add', body: '缺少 doc_id' },
      { action: 'add', doc_id: h.docId },
      { action: 'add', doc_id: h.docId, body: '   ' },
      {
        action: 'add',
        doc_id: h.docId,
        body: '锚点 block_id 为空',
        anchor: { block_id: ' ', offset: 0, length: 1 },
      },
      {
        action: 'add',
        doc_id: h.docId,
        body: '锚点 offset 为负',
        anchor: { block_id: h.blockId, offset: -1, length: 1 },
      },
      {
        action: 'add',
        doc_id: h.docId,
        body: '锚点 length 为零',
        anchor: { block_id: h.blockId, offset: 0, length: 0 },
      },
      {
        action: 'add',
        doc_id: h.docId,
        body: '引文为空串',
        quote: '   ',
      },
      { action: 'update', comment_id: 'cm-missing' },
      { action: 'delete' },
    ];
    for (const args of cases) {
      const error = await failure(h.tools.call('space_comments', args));
      expect(error.message, JSON.stringify(args)).toContain(
        'space/invalid-input',
      );
    }
    const scalar = await failure(
      h.tools.call('space_comments', null as never),
    );
    expect(scalar.message).toContain('space/invalid-input');
  });

  it('declares read concurrency and renders the listing text', async () => {
    const h = await openFixture();
    const definition = h.tools.definitions.get('space_comments');
    expect(definition).toBeDefined();
    expect(definition!.isConcurrencySafe?.({ action: 'list' })).toBe(true);
    for (const action of ['add', 'update', 'supplement', 'delete', 'resolve'])
      expect(definition!.isConcurrencySafe?.({ action })).toBe(false);
    expect(definition!.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Manage document comments',
      kind: 'edit',
    });

    const added = asComment(
      await h.tools.call('space_comments', {
        action: 'add',
        doc_id: h.docId,
        body: '渲染检查',
        quote: '正文段落',
        anchor: { block_id: h.blockId, offset: 0, length: 2 },
      }),
    );
    const listed = asList(
      await h.tools.call('space_comments', {
        action: 'list',
        doc_id: h.docId,
      }),
    );
    const rendered = h.tools.render(
      'space_comments',
      { action: 'list', doc_id: h.docId },
      listed,
    );
    expect(rendered).toContain('共 1 条评论');
    expect(rendered).toContain(added.id);
    expect(rendered).toContain('渲染检查');
  });
});