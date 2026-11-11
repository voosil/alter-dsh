/**
 * G2 seeded random walk runner.
 *
 * The nightly suite runs many sequences; the PR gate runs the same generator
 * with a small sequence count so a regression still surfaces in seconds. The
 * runner is shared support (not a test file) so both suites exercise one
 * implementation.
 */
import type { AlterDoc } from '../../host/document/editors/legacy/types.js';
import { assertValidDocument } from './ast-checks.js';

/** Stable rejection codes a generated batch may legitimately hit. */
const STABLE_CODES = new Set<string>([
  'doc/not-found',
  'doc/conflict',
  'doc/too-large',
  'doc/schema-invalid',
  'op/invalid',
  'node/not-found',
  'node/schema-invalid',
  'node/unsupported-transform',
  'node/not-writable',
  'object/invalid',
  'parse/unsupported',
  'idempotency/conflict',
]);

export interface FuzzServices {
  get(docId: string): Promise<{ revision: number; doc: AlterDoc }>;
  applyOperations(input: {
    docId: string;
    baseRevision: number;
    ops: unknown[];
  }): Promise<{ revision: number }>;
  undo(input: { docId: string; baseRevision: number }): Promise<{ revision: number }>;
}

export interface FuzzOptions {
  seed: number;
  sequences: number;
  batchesPerSequence: number;
  createDocument: (sequence: number) => Promise<string>;
  buildBatch: (doc: AlterDoc, tag: string) => unknown[];
  releaseDocument: (docId: string) => Promise<void>;
  context: (sequence: number, batch: number) => string;
}

export interface FuzzReport {
  batches: number;
  undos: number;
  operations: Set<string>;
}

/**
 * Run one seeded random walk over the document operation surface.
 *
 * Throws with the deterministic seed/sequence/batch context on the first
 * invariant violation, which is what makes a counterexample reproducible.
 */
export async function runFuzz(service: FuzzServices, options: FuzzOptions): Promise<FuzzReport> {
  const report: FuzzReport = { batches: 0, undos: 0, operations: new Set() };
  const rejectionDetails: string[] = [];
  for (let sequence = 0; sequence < options.sequences; sequence += 1) {
    const docId = await options.createDocument(sequence);
    try {
      for (let batchIndex = 0; batchIndex < options.batchesPerSequence; batchIndex += 1) {
        const context = options.context(sequence, batchIndex);
        const before = await service.get(docId);
        assertValidDocument(before.doc, `${context} before`);
        const ops = options.buildBatch(before.doc, `s${sequence}_${batchIndex}`);
        if (ops.length === 0) throw new Error(`${context}: empty batch`);
        report.batches += 1;
        for (const op of ops) {
          const name = (op as { op?: unknown }).op;
          if (typeof name === 'string') report.operations.add(name);
        }

        let applied: { revision: number };
        try {
          applied = await service.applyOperations({
            docId,
            baseRevision: before.revision,
            ops,
          });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === undefined || !STABLE_CODES.has(code))
            throw new Error(`${context}: unexpected rejection ${String(error)}`);
          rejectionDetails.push(`${context} code=${code}`);
          const unchanged = await service.get(docId);
          if (unchanged.revision !== before.revision)
            throw new Error(`${context}: rejection changed the revision`);
          continue;
        }

        if (applied.revision !== before.revision + 1)
          throw new Error(`${context}: revision did not advance by one`);
        const after = await service.get(docId);
        assertValidDocument(after.doc, context);

        if (batchIndex % 4 === 3) {
          const undone = await service.undo({ docId, baseRevision: after.revision });
          if (undone.revision !== after.revision + 1)
            throw new Error(`${context}: undo revision mismatch`);
          const restored = await service.get(docId);
          if (JSON.stringify(restored.doc.blocks) !== JSON.stringify(before.doc.blocks))
            throw new Error(`${context}: undo did not restore the previous tree`);
          report.undos += 1;
        }
      }
    } finally {
      await options.releaseDocument(docId);
    }
  }
  if (rejectionDetails.length > 0)
    throw new Error(`${rejectionDetails.length} unexpected rejections:\n${rejectionDetails.slice(0, 5).join('\n')}`);
  return report;
}