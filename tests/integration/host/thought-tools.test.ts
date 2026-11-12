/**
 * Agent `space_thoughts` tool over a real local authority runtime.
 *
 * The tool is a thin adapter over the alter-bound endpoint caller, so these
 * tests drive the real SQLite authority through `runtimeAgentRpc`: the eight
 * actions, `creator === 'alter'` attribution, cross-space moves, the converted
 * document and the bounded read projection (200-char preview, 50-row cap).
 * Argument validation and error mapping are covered against the same runtime.
 */
import { describe, expect, it } from 'vitest';
import type { Space, SpaceNode, Thought } from '@alter/protocol';
import { registerThoughtTools } from '../../../host/authority/thought-tools.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import type { RpcCall } from '../../../host/authority/tool-support.js';
import { runtimeAgentRpc } from '../../support/agent-rpc.js';
import { startRuntime } from '../../support/harness.js';
import { dispose } from '../../support/lifecycle.js';

const signal = new AbortController().signal;
const DEFAULT_SPACE = 'sp-inbox';

interface ToolHarness {
  definitions: Map<string, ToolDefinitionLike>;
  rpc: RpcCall;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  render(name: string, args: unknown, value: unknown): string;
}

/** Capture the tool definitions over one real alter-bound endpoint caller. */
function captureTools(): Promise<ToolHarness> {
  return startRuntime().then(({ runtime }) => {
    const rpc = runtimeAgentRpc(runtime);
    const definitions = new Map<string, ToolDefinitionLike>();
    const tools: ToolsLike = {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {
          definitions.delete(definition.name);
        };
      },
    };
    dispose(registerThoughtTools(tools, { rpc }));
    return {
      definitions,
      rpc,
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
  });
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

interface ThoughtMeta {
  id: string;
  space_id: string;
  creator: string;
  content: string;
  archived: boolean;
  converted_doc_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ThoughtListResult {
  space_id: string;
  total: number;
  truncated: boolean;
  thoughts: ThoughtMeta[];
}

function thoughtOf(result: unknown): ThoughtMeta {
  return (result as { thought: ThoughtMeta }).thought;
}

async function rawThoughts(
  h: ToolHarness,
  spaceId: string,
  includeArchived = true,
): Promise<Thought[]> {
  return (await h.rpc('space.listThoughts', [
    spaceId,
    { includeArchived },
  ])) as Thought[];
}

describe('space_thoughts', () => {
  it('runs every action, attributes writes to alter and moves across spaces', async () => {
    const h = await captureTools();
    const target = (await h.rpc('space.createSpace', [
      { name: '目标空间' },
    ])) as Space;

    const created = thoughtOf(
      await h.call('space_thoughts', {
        action: 'create',
        space_id: DEFAULT_SPACE,
        content: '随想正文一',
      }),
    );
    expect(created.id).toBeTruthy();
    expect(created.space_id).toBe(DEFAULT_SPACE);
    expect(created.creator).toBe('alter');
    expect(created.content).toBe('随想正文一');
    expect(created.archived).toBe(false);
    expect(created.converted_doc_id).toBeNull();
    // The authority persists the same attribution the projection shows.
    const persisted = await rawThoughts(h, DEFAULT_SPACE);
    expect(persisted.find((thought) => thought.id === created.id)?.creator).toBe(
      'alter',
    );

    const listed = (await h.call('space_thoughts', {
      action: 'list',
      space_id: DEFAULT_SPACE,
    })) as ThoughtListResult;
    expect(listed.total).toBe(1);
    expect(listed.truncated).toBe(false);
    expect(listed.thoughts.map((thought) => thought.id)).toEqual([created.id]);
    expect(h.render('space_thoughts', { action: 'list' }, listed)).toContain(
      '随想正文一 · Alter',
    );

    const updated = thoughtOf(
      await h.call('space_thoughts', {
        action: 'update',
        thought_id: created.id,
        content: '随想正文一（改）',
      }),
    );
    expect(updated.content).toBe('随想正文一（改）');
    expect(updated.updated_at >= created.updated_at).toBe(true);

    const archived = thoughtOf(
      await h.call('space_thoughts', {
        action: 'archive',
        thought_id: created.id,
        archived: true,
      }),
    );
    expect(archived.archived).toBe(true);
    // Archived thoughts leave the default list but stay with include_archived.
    const defaultList = (await h.call('space_thoughts', {
      action: 'list',
      space_id: DEFAULT_SPACE,
    })) as ThoughtListResult;
    expect(defaultList.thoughts).toEqual([]);
    const fullList = (await h.call('space_thoughts', {
      action: 'list',
      space_id: DEFAULT_SPACE,
      include_archived: true,
    })) as ThoughtListResult;
    expect(fullList.thoughts.map((thought) => thought.id)).toEqual([
      created.id,
    ]);

    const unarchived = thoughtOf(
      await h.call('space_thoughts', {
        action: 'archive',
        thought_id: created.id,
        archived: false,
      }),
    );
    expect(unarchived.archived).toBe(false);

    const moved = thoughtOf(
      await h.call('space_thoughts', {
        action: 'move',
        thought_id: created.id,
        target_space_id: target.id,
      }),
    );
    expect(moved.space_id).toBe(target.id);
    expect(
      (
        (await h.call('space_thoughts', {
          action: 'list',
          space_id: DEFAULT_SPACE,
        })) as ThoughtListResult
      ).thoughts,
    ).toEqual([]);
    expect(
      (
        (await h.call('space_thoughts', {
          action: 'list',
          space_id: target.id,
        })) as ThoughtListResult
      ).thoughts.map((thought) => thought.id),
    ).toEqual([created.id]);

    const deleted = (await h.call('space_thoughts', {
      action: 'delete',
      thought_id: created.id,
    })) as { deleted: boolean; thought_id: string };
    expect(deleted).toEqual({ deleted: true, thought_id: created.id });
    expect(
      (
        (await h.call('space_thoughts', {
          action: 'list',
          space_id: target.id,
        })) as ThoughtListResult
      ).thoughts,
    ).toEqual([]);
    const trash = (await h.rpc('space.listDeleted', [target.id])) as {
      thoughts: Thought[];
    };
    expect(trash.thoughts.map((thought) => thought.id)).toContain(created.id);

    const restored = thoughtOf(
      await h.call('space_thoughts', {
        action: 'restore',
        thought_id: created.id,
      }),
    );
    expect(restored.id).toBe(created.id);
    expect(restored.space_id).toBe(target.id);

    // Convert: the thought becomes a new Alter-owned document in its space.
    const convertable = thoughtOf(
      await h.call('space_thoughts', {
        action: 'create',
        space_id: target.id,
        content: '值得写成文档的随想',
      }),
    );
    const converted = (await h.call('space_thoughts', {
      action: 'convert',
      thought_id: convertable.id,
    })) as {
      thought: ThoughtMeta;
      doc_id: string;
      title: string;
    };
    expect(converted.doc_id).toBeTruthy();
    expect(converted.thought.converted_doc_id).toBe(converted.doc_id);
    const node = (await h.rpc('space.getNode', [
      converted.doc_id,
    ])) as SpaceNode | null;
    expect(node).not.toBeNull();
    expect(node?.spaceId).toBe(target.id);
    expect(node?.kind).toBe('note');
    // A converted thought leaves the thought list (it is a document now).
    expect(
      (
        (await h.call('space_thoughts', {
          action: 'list',
          space_id: target.id,
        })) as ThoughtListResult
      ).thoughts.map((thought) => thought.id),
    ).not.toContain(convertable.id);
    expect(
      h.render('space_thoughts', { action: 'convert' }, converted),
    ).toContain(converted.doc_id);
  });

  it('bounds the read projection: 200-char previews and 50 rows', async () => {
    const h = await captureTools();

    const longThought = thoughtOf(
      await h.call('space_thoughts', {
        action: 'create',
        space_id: DEFAULT_SPACE,
        content: '长'.repeat(300),
      }),
    );
    const longList = (await h.call('space_thoughts', {
      action: 'list',
      space_id: DEFAULT_SPACE,
    })) as ThoughtListResult;
    const previewed = longList.thoughts.find(
      (thought) => thought.id === longThought.id,
    );
    expect(previewed?.content).toHaveLength(200);

    const crowded = (await h.rpc('space.createSpace', [
      { name: '拥挤空间' },
    ])) as Space;
    for (let index = 0; index < 52; index += 1)
      await h.rpc('space.createThought', [
        { spaceId: crowded.id, content: `随想 ${index + 1}` },
      ]);
    const capped = (await h.call('space_thoughts', {
      action: 'list',
      space_id: crowded.id,
    })) as ThoughtListResult;
    expect(capped.total).toBe(52);
    expect(capped.truncated).toBe(true);
    expect(capped.thoughts).toHaveLength(50);
    for (const thought of capped.thoughts)
      expect(thought.content.length).toBeLessThanOrEqual(200);
  });

  it('rejects invalid arguments with actionable codes', async () => {
    const h = await captureTools();
    const missingAction = await failure(
      h.call('space_thoughts', { space_id: DEFAULT_SPACE }),
    );
    expect(missingAction.message).toContain('space/invalid-input');
    expect(missingAction.message).toContain('action 必须是');

    const missingSpace = await failure(
      h.call('space_thoughts', { action: 'list' }),
    );
    expect(missingSpace.message).toContain('space/invalid-input');
    expect(missingSpace.message).toContain('space_id');

    const missingContent = await failure(
      h.call('space_thoughts', {
        action: 'create',
        space_id: DEFAULT_SPACE,
      }),
    );
    expect(missingContent.message).toContain('content');

    const missingArchived = await failure(
      h.call('space_thoughts', {
        action: 'archive',
        thought_id: 'th-missing',
      }),
    );
    expect(missingArchived.message).toContain('archived');

    const missingThought = await failure(
      h.call('space_thoughts', { action: 'delete' }),
    );
    expect(missingThought.message).toContain('thought_id');

    const unknownThought = await failure(
      h.call('space_thoughts', {
        action: 'update',
        thought_id: 'th-missing',
        content: '任意',
      }),
    );
    expect(unknownThought.message).toContain('space/failed');
    expect(unknownThought.message).toContain('随想不存在');
    expect(unknownThought.message).toContain('space_thoughts list');
  });

  it('declares the ledger action enum and read/write metadata', async () => {
    const h = await captureTools();
    const definition = h.definitions.get('space_thoughts');
    if (definition === undefined)
      throw new Error('space_thoughts is not registered');
    const properties = definition.parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(properties.action?.enum).toEqual([
      'list',
      'create',
      'update',
      'archive',
      'delete',
      'restore',
      'move',
      'convert',
    ]);
    expect(definition.isConcurrencySafe?.({ action: 'list' })).toBe(true);
    expect(definition.isConcurrencySafe?.({ action: 'create' })).toBe(false);
    expect(definition.presentCall?.({ action: 'list' })).toEqual({
      card: 'generic',
      title: 'Space thoughts',
      kind: 'read',
    });
    expect(definition.presentCall?.({ action: 'delete' })).toEqual({
      card: 'generic',
      title: 'Space thoughts',
      kind: 'edit',
    });
  });

  it('removes every registration on dispose', async () => {
    const { runtime } = await startRuntime();
    const rpc = runtimeAgentRpc(runtime);
    const definitions = new Map<string, ToolDefinitionLike>();
    const tools: ToolsLike = {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {
          definitions.delete(definition.name);
        };
      },
    };
    const disposer = registerThoughtTools(tools, { rpc });
    expect([...definitions.keys()]).toEqual(['space_thoughts']);
    disposer();
    expect(definitions.size).toBe(0);
  });
});