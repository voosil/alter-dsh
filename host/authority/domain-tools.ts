/**
 * Domain tools added after P1: comments, versions, thoughts, governance,
 * collaborators, hub, and file import.
 *
 * Each domain keeps its own module so the tool surface stays readable; this
 * composer registers them together so the Host wires one disposer and the
 * parity gate captures the whole set from one call.
 *
 * @module @alter-dsh/space/authority/domain-tools
 */
import type { ToolsLike } from '../document/editors/legacy/tools.js';
import { registerCommentTools } from './comment-tools.js';
import { registerGovernanceTools } from './governance-tools.js';
import { registerHubTools } from './hub-tools.js';
import { registerImportTools } from './import-tools.js';
import { registerThoughtTools } from './thought-tools.js';
import type { RpcToolDeps } from './tool-support.js';
import { registerVersionTools } from './version-tools.js';

/**
 * Register every domain tool on one Host tools service.
 * @param tools - Host tools service.
 * @param deps - alter-bound endpoint caller plus the approval resolver.
 * @returns disposer that removes every registration.
 */
export function registerSpaceDomainTools(
  tools: ToolsLike,
  deps: RpcToolDeps,
): () => void {
  const disposers = [
    registerCommentTools(tools, deps),
    registerVersionTools(tools, deps),
    registerThoughtTools(tools, deps),
    registerGovernanceTools(tools, deps),
    registerHubTools(tools, deps),
    registerImportTools(tools, deps),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}