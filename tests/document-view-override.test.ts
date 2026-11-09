import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDocumentViewOverride } from '../build/document-view-override.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = createDocumentViewOverride(root);
const adaptive = path.join(root, 'src', 'document', 'adaptive-document-view.tsx');

function resolve(source: string, importer: string): string | null {
  return plugin.resolveId(source, path.join(root, importer)) as string | null;
}

describe('build-time document view override', () => {
  it('redirects SpaceApp DocumentView to the adaptive view', () => {
    expect(
      resolve('./views/DocumentView', 'vendor/ui-space/src/SpaceApp.tsx'),
    ).toBe(adaptive);
  });

  it('leaves other DocumentView imports and modules untouched', () => {
    expect(
      resolve('./views/DocumentView', 'vendor/ui-space/src/views/OtherView.tsx'),
    ).toBeNull();
    expect(
      resolve('./views/Other', 'vendor/ui-space/src/SpaceApp.tsx'),
    ).toBeNull();
  });

  it('does not recurse into the adaptive view import of the vendored view', () => {
    expect(
      resolve(
        '../../vendor/ui-space/src/views/DocumentView',
        'src/document/adaptive-document-view.tsx',
      ),
    ).toBeNull();
  });
});
