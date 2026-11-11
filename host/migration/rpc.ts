/**
 * Control-plane RPC for migration jobs.
 *
 * @module @alter-dsh/space/migration/rpc
 */
import type { MigrationService, MigrationDirection } from './service.js';
import type { SpaceRpcHandler } from '../rpc.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argsOf(payload: unknown): unknown[] {
  if (!isPlainObject(payload)) return [];
  return Array.isArray(payload.args) ? payload.args : [];
}

function directionOf(value: unknown): MigrationDirection {
  if (value === 'to-server' || value === 'from-server') return value;
  throw new Error('direction 必须是 to-server 或 from-server');
}

function errorOf(error: unknown): { error: { code: string; message: string } } {
  return {
    error: {
      code: 'migration/failed',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Build the migration RPC handler for the plugin route.
 * @param service - migration job owner.
 */
export function createMigrationRpcHandler(
  service: MigrationService,
): SpaceRpcHandler {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'migration.preflight') {
        const input = argsOf(payload)[0];
        const direction = directionOf(
          isPlainObject(input) ? input.direction : undefined,
        );
        return { value: await service.preflight(direction) };
      }
      if (endpoint === 'migration.start') {
        const raw = argsOf(payload)[0];
        const input: Record<string, unknown> = isPlainObject(raw) ? raw : {};
        const direction = directionOf(input.direction);
        return {
          value: await service.start({
            direction,
            overwrite: input.overwrite === true,
            trimHistory: input.trimHistory === true,
          }),
        };
      }
      if (endpoint === 'migration.status')
        return { value: service.status() };
      if (endpoint === 'migration.cancel') {
        service.cancel();
        return { value: service.status() };
      }
      throw new Error(`未知的迁移接口 ${endpoint}`);
    } catch (error) {
      return errorOf(error);
    }
  };
}
