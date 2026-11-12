/**
 * Agent `space_import_file` tool over the real local authority.
 *
 * The import goes through the same alter-bound `doc.importFile` endpoint the
 * browser uses, so the test proves byte accounting, the asset id shape, the
 * optional display name and content-addressed deduplication without stubbing
 * the authority.
 */
import { describe, expect, it } from 'vitest';
import { registerImportTools } from '../../../host/authority/import-tools.js';
import type { RpcCall } from '../../../host/authority/tool-support.js';
import type {
  ToolDefinitionLike,
  ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import { runtimeAgentRpc } from '../../support/agent-rpc.js';
import { startRuntime } from '../../support/harness.js';

const signal = new AbortController().signal;
const HELLO_BASE64 = Buffer.from('hello').toString('base64');

interface ImportedFileProjection {
  asset_id: string;
  mime: string;
  bytes: number;
  name?: string;
}

interface ToolHarness {
  definitions: Map<string, ToolDefinitionLike>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Capture `space_import_file` over one alter-bound endpoint caller. */
function captureTools(rpc: RpcCall): ToolHarness {
  const definitions = new Map<string, ToolDefinitionLike>();
  const tools: ToolsLike = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {
        definitions.delete(definition.name);
      };
    },
  };
  registerImportTools(tools, { rpc });
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
  };
}

async function localTools(): Promise<ToolHarness> {
  const { runtime } = await startRuntime();
  return captureTools(runtimeAgentRpc(runtime));
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

describe('space_import_file in local mode', () => {
  it('imports a text file and returns its id, mime and byte size', async () => {
    const tools = await localTools();
    const imported = (await tools.call('space_import_file', {
      mime: 'text/plain',
      data_base64: HELLO_BASE64,
    })) as ImportedFileProjection;

    expect(imported.asset_id).toMatch(/^asset_/);
    expect(imported.mime).toBe('text/plain');
    expect(imported.bytes).toBe(5);
    expect(imported.name).toBeUndefined();
  });

  it('keeps the optional display name and deduplicates identical bytes', async () => {
    const tools = await localTools();
    const named = (await tools.call('space_import_file', {
      mime: 'text/plain',
      data_base64: HELLO_BASE64,
      name: 'hello.txt',
    })) as ImportedFileProjection;
    expect(named.name).toBe('hello.txt');
    expect(named.bytes).toBe(5);

    const again = (await tools.call('space_import_file', {
      mime: 'text/plain',
      data_base64: HELLO_BASE64,
    })) as ImportedFileProjection;
    expect(again.asset_id).toBe(named.asset_id);
  });

  it('rejects missing required arguments and malformed base64', async () => {
    const tools = await localTools();
    const noMime = await failure(
      tools.call('space_import_file', { data_base64: HELLO_BASE64 }),
    );
    expect(noMime.message).toContain('mime');
    const noData = await failure(
      tools.call('space_import_file', { mime: 'text/plain' }),
    );
    expect(noData.message).toContain('data_base64');
    const malformed = await failure(
      tools.call('space_import_file', {
        mime: 'text/plain',
        data_base64: 'not base64!',
      }),
    );
    expect(malformed.message).toContain('base64');
  });
});