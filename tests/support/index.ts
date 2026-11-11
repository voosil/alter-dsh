/**
 * Shared test support.
 *
 * Tests never import another test file; every reusable fixture, fake and
 * lifecycle helper lives here. Layering rules and the rationale are in
 * `docs/specs/system-architecture.md` §5.
 */
export * from './lifecycle';
export * from './dsh-fakes';
export * from './harness';
export * from './documents';
export * from './workspace-fixtures';