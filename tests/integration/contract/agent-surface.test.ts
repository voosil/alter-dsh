/**
 * Agent surface parity gate.
 *
 * The capability ledger (`host/authority/capabilities.ts`) is the single source
 * of truth for the operation surface. This suite keeps four declarations from
 * drifting apart: the ledger, the `rpc.ts` whitelists, the read classification
 * derived in `endpoints.ts`, and the Agent tool definitions actually registered
 * by the Host. Tool definitions are captured through a fake `ToolsLike` with
 * deps that fail loudly if touched — registration must never execute business
 * code.
 *
 * `space_doc_patch` has no endpoint of its own (it wraps `doc.applyOps` as a
 * single-block replacement); the ledger registers it in `ENDPOINTLESS_TOOLS`
 * rather than doubling the `doc.applyOps` row, and this suite accepts it there.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ENDPOINTLESS_TOOLS,
  agentMappings,
  businessReadEndpoints,
  endpointsForTool,
  getCapability,
} from '../../../host/authority/capabilities.js';
import { READ_ENDPOINTS, isReadEndpoint } from '../../../host/authority/endpoints.js';
import {
  DOCUMENT_METHODS,
  HUB_METHODS,
  MIGRATION_METHODS,
  OBJECT_METHODS,
  SETTINGS_METHODS,
  SPACE_METHODS,
  STORAGE_METHODS,
  SYNC_METHODS,
} from '../../../host/authority/rpc.js';
import {
  registerDocumentTools,
  type ToolDefinitionLike,
  type ToolsLike,
} from '../../../host/document/editors/legacy/tools.js';
import { registerSpaceDomainTools } from '../../../host/authority/domain-tools.js';
import { registerSpaceTools } from '../../../host/authority/space-tools.js';
import type { SpaceToolApi } from '../../../host/core/backend.js';
import { registerAgentSettingsTool } from '../../../host/control/agent-settings-tool.js';
import { registerAgentMigrationTool } from '../../../host/control/agent-migration-tool.js';
import type { ConnectionAudit } from '../../../host/control/connection-audit.js';
import type { ConnectionSettingsStore } from '../../../host/control/connection-settings.js';
import type { MigrationService } from '../../../host/control/migration/service.js';
import type { SpaceModeController } from '../../../host/core/mode.js';

/** Every endpoint the Host whitelists, business plus control plane. */
function hostWhitelist(): string[] {
  return [
    ...SPACE_METHODS.map((method) => `space.${method}`),
    ...HUB_METHODS.map((method) => `hub.${method}`),
    ...STORAGE_METHODS.map((method) => `storage.${method}`),
    ...DOCUMENT_METHODS.map((method) => `doc.${method}`),
    ...OBJECT_METHODS.map((method) => `object.${method}`),
    ...SETTINGS_METHODS.map((method) => `settings.${method}`),
    ...SYNC_METHODS.map((method) => `sync.${method}`),
    ...MIGRATION_METHODS.map((method) => `migration.${method}`),
  ];
}

const CONTROL_GROUPS = new Set(['settings', 'sync', 'migration']);

/**
 * Schema byte ratchet over `JSON.stringify(def.parameters)` of every registered
 * tool. Measured 12936 bytes on the current 22-tool surface (P1's 15 tools were
 * 7718; the P2–P4 domain tools added 5218), rounded up to 13200.
 * The cap may only rise deliberately — 上限调整必须同步 spec
 * （docs/specs/agent-tools-v1.md §6 与 docs/specs/agent-tools-p2-p4.md §11）。
 */
const SCHEMA_BYTE_BUDGET = 13200;

/** Deps double that fails loudly if registration touches business code. */
function forbidden<T>(label: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(
        `registration must not execute deps: ${label}.${String(property)}`,
      );
    },
  });
}

/** Capture every tool definition the four registrars install. */
function registeredDefinitions(): ToolDefinitionLike[] {
  const definitions: ToolDefinitionLike[] = [];
  const tools: ToolsLike = {
    register(definition) {
      definitions.push(definition);
      return () => {};
    },
  };
  registerDocumentTools(tools, {
    service: forbidden('document service'),
    assets: forbidden('asset store'),
  });
  registerSpaceTools(tools, {
    service: forbidden<SpaceToolApi>('space service'),
  });
  registerSpaceDomainTools(tools, {
    rpc: forbidden('domain tool rpc'),
    approval: () => undefined,
  });
  registerAgentSettingsTool(tools, {
    settings: forbidden<ConnectionSettingsStore>('settings store'),
    mode: forbidden<SpaceModeController>('mode controller'),
    directory: '/unused-during-registration',
    audit: forbidden<ConnectionAudit>('connection audit'),
  });
  registerAgentMigrationTool(tools, {
    migration: forbidden<MigrationService>('migration service'),
    audit: forbidden<ConnectionAudit>('connection audit'),
  });
  return definitions;
}

/** Top-level parameter names of one tool definition. */
function parameterKeys(definition: ToolDefinitionLike): string[] {
  const properties = definition.parameters.properties;
  if (typeof properties !== 'object' || properties === null) return [];
  return Object.keys(properties);
}

/** The `action` enum of an action-dispatched tool, when it declares one. */
function actionEnum(definition: ToolDefinitionLike): string[] {
  const properties = definition.parameters.properties;
  if (typeof properties !== 'object' || properties === null) return [];
  const action = (properties as Record<string, unknown>).action;
  if (typeof action !== 'object' || action === null) return [];
  const values = (action as { enum?: unknown }).enum;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string');
}

/** Tools the ledger maps from control-plane rows. */
function controlPlaneTools(): Set<string> {
  return new Set(
    CAPABILITIES.filter(
      (capability) =>
        capability.kind === 'control' && 'tool' in capability.agent,
    ).map((capability) =>
      'tool' in capability.agent ? capability.agent.tool : '',
    ),
  );
}

describe('ledger ↔ host whitelist', () => {
  it('covers every whitelisted endpoint exactly once', () => {
    const endpoints = CAPABILITIES.map((capability) => capability.endpoint);
    expect(new Set(endpoints).size, 'duplicate ledger rows').toBe(
      endpoints.length,
    );
    expect([...endpoints].sort()).toEqual(hostWhitelist().sort());
  });

  it('classifies control plane, kinds and destructive endpoints consistently', () => {
    for (const capability of CAPABILITIES) {
      const [group, method] = capability.endpoint.split('.');
      expect(method, capability.endpoint).toBeTruthy();
      expect(
        CONTROL_GROUPS.has(group) === (capability.kind === 'control'),
        `${capability.endpoint} kind=${capability.kind}`,
      ).toBe(true);
      if ('tool' in capability.agent) {
        expect(capability.agent.tool, capability.endpoint).toMatch(/^space_/);
      } else {
        expect(capability.agent.excluded.trim(), capability.endpoint).not.toBe(
          '',
        );
      }
    }
    // Destructive classification is a safety boundary: changing this set is a
    // deliberate surface decision, not a side effect of adding an endpoint.
    expect(
      CAPABILITIES.filter((capability) => capability.kind === 'destructive')
        .map((capability) => capability.endpoint)
        .sort(),
    ).toEqual(
      [
        'doc.restoreVersion',
        'space.deleteComment',
        'space.deleteSpace',
        'space.emptyTrash',
        'space.restoreVersion',
      ].sort(),
    );
  });

  it('keeps the lookup helpers consistent with the rows', () => {
    for (const capability of CAPABILITIES) {
      expect(getCapability(capability.endpoint)).toBe(capability);
    }
    expect(getCapability('space.notARealMethod')).toBeUndefined();
    for (const tool of new Set(agentMappings().map((mapping) => mapping.tool))) {
      expect(endpointsForTool(tool)).toEqual(
        CAPABILITIES.filter(
          (capability) =>
            'tool' in capability.agent && capability.agent.tool === tool,
        ),
      );
    }
  });
});

describe('read classification', () => {
  /**
   * Independent expectation for the read set. It is a literal, hand-maintained
   * anchor on purpose: deriving it from the same ledger the code derives from
   * would make this gate tautological, so a row flipped to `read` in the ledger
   * would silently redefine its own expectation.
   */
  const EXPECTED_READ_ENDPOINTS = [
    'space.listSpaces',
    'space.getSpace',
    'space.listArchivedSpaces',
    'space.listNodes',
    'space.getNode',
    'space.listComments',
    'space.listVersions',
    'space.listThoughts',
    'space.listDeleted',
    'space.search',
    'space.getOverview',
    'space.listAgents',
    'space.listDirectories',
    'hub.get',
    'storage.get',
    'storage.estimate',
    'doc.get',
    'doc.outline',
    'doc.read',
    'doc.search',
    'object.get',
  ];

  it('derives READ_ENDPOINTS from the ledger business read rows', () => {
    const ledgerReads = CAPABILITIES.filter(
      (capability) => capability.kind === 'read',
    ).map((capability) => capability.endpoint);
    // Exact order too: the derivation must stay byte-neutral for consumers
    // that iterate the set.
    expect([...READ_ENDPOINTS]).toEqual(ledgerReads);
    expect([...businessReadEndpoints()]).toEqual(ledgerReads);
    // The anchor above is what actually guards the classification.
    expect(ledgerReads).toEqual(EXPECTED_READ_ENDPOINTS);
  });

  it('never classifies write, destructive or control endpoints as reads', () => {
    for (const capability of CAPABILITIES) {
      const expectedRead = EXPECTED_READ_ENDPOINTS.includes(
        capability.endpoint,
      );
      expect(
        isReadEndpoint(capability.endpoint),
        `${capability.endpoint} kind=${capability.kind}`,
      ).toBe(expectedRead);
      if (!expectedRead)
        expect(READ_ENDPOINTS.has(capability.endpoint)).toBe(false);
    }
  });
});

describe('ledger ↔ registered Agent tools', () => {
  it('registers every mapped tool and action', () => {
    const definitions = registeredDefinitions();
    const byName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );
    for (const mapping of agentMappings()) {
      const definition = byName.get(mapping.tool);
      expect(definition, `${mapping.endpoint} → ${mapping.tool}`).toBeDefined();
      if (mapping.action === undefined) continue;
      expect(
        actionEnum(definition!),
        `${mapping.endpoint} → ${mapping.tool}{action:${mapping.action}}`,
      ).toContain(mapping.action);
    }
  });

  it('covers every action of an action-dispatched tool from the ledger', () => {
    const definitions = registeredDefinitions();
    const byName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );
    const mappedActions = new Map<string, Set<string>>();
    for (const mapping of agentMappings()) {
      if (mapping.action === undefined) continue;
      const actions = mappedActions.get(mapping.tool) ?? new Set<string>();
      actions.add(mapping.action);
      mappedActions.set(mapping.tool, actions);
    }
    for (const [tool, actions] of mappedActions) {
      // An enum value without a ledger row would be an undeclared capability.
      expect([...actions].sort(), tool).toEqual(
        actionEnum(byName.get(tool)!).sort(),
      );
    }
  });

  it('accounts for every registered tool exactly once', () => {
    const definitions = registeredDefinitions();
    const names = definitions.map((definition) => definition.name);
    expect(new Set(names).size, 'duplicate tool registrations').toBe(
      names.length,
    );
    const ledgerTools = new Set(
      agentMappings().map((mapping) => mapping.tool),
    );
    const endpointless = new Set(
      ENDPOINTLESS_TOOLS.map((entry) => entry.tool),
    );
    for (const name of names) {
      expect(
        ledgerTools.has(name) || endpointless.has(name),
        `unaccounted tool ${name}`,
      ).toBe(true);
    }
    // No double accounting: an endpointless tool is not also a ledger mapping.
    for (const tool of endpointless) expect(ledgerTools.has(tool)).toBe(false);
  });

  it('keeps ENDPOINTLESS_TOOLS entries registered and justified', () => {
    const names = new Set(
      registeredDefinitions().map((definition) => definition.name),
    );
    for (const entry of ENDPOINTLESS_TOOLS) {
      expect(names.has(entry.tool), entry.tool).toBe(true);
      expect(entry.reason.trim(), entry.tool).not.toBe('');
    }
  });
});

describe('schema byte budget', () => {
  it('stays within the ratchet', () => {
    const definitions = registeredDefinitions();
    const total = definitions.reduce(
      (sum, definition) => sum + JSON.stringify(definition.parameters).length,
      0,
    );
    expect(
      total,
      `measured schema bytes=${total}, budget=${SCHEMA_BYTE_BUDGET}`,
    ).toBeLessThanOrEqual(SCHEMA_BYTE_BUDGET);
  });
});

describe('parameter naming conventions', () => {
  const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

  it('keeps document/space tool parameters snake_case', () => {
    const control = controlPlaneTools();
    for (const definition of registeredDefinitions()) {
      if (control.has(definition.name)) continue;
      for (const key of parameterKeys(definition)) {
        expect(SNAKE_CASE.test(key), `${definition.name}.${key}`).toBe(true);
      }
    }
  });

  it('allows camelCase only on control-plane tools', () => {
    const control = controlPlaneTools();
    expect(control.size).toBeGreaterThan(0);
    for (const definition of registeredDefinitions()) {
      if (!control.has(definition.name)) continue;
      for (const key of parameterKeys(definition)) {
        expect(
          SNAKE_CASE.test(key) || CAMEL_CASE.test(key),
          `${definition.name}.${key}`,
        ).toBe(true);
      }
    }
  });
});