import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDirectoryFieldOverride } from '../../build/directory-field-override.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const plugin = createDirectoryFieldOverride(root);
const nativeField = path.join(root, 'src', 'app', 'native-directory-field.tsx');

/** Resolve one import through the override plugin. */
function resolve(source: string, importer: string): string | null {
  return plugin.resolveId(source, path.join(root, importer)) as string | null;
}

describe('build-time directory field override', () => {
  it('redirects the two import sites to the native field', () => {
    expect(
      resolve(
        './DirectoryField',
        'vendor/ui-space/src/components/CreateSpaceDialog.tsx',
      ),
    ).toBe(nativeField);
    expect(
      resolve(
        '../components/DirectoryField',
        'vendor/ui-space/src/views/ConfigView.tsx',
      ),
    ).toBe(nativeField);
  });

  it('leaves every other import untouched', () => {
    expect(
      resolve(
        './DirectoryField',
        'vendor/ui-space/src/views/DocumentView.tsx',
      ),
    ).toBeNull();
    expect(
      resolve(
        '../components/DirectoryField',
        'vendor/ui-space/src/views/OtherView.tsx',
      ),
    ).toBeNull();
    expect(
      resolve('./Other', 'vendor/ui-space/src/components/CreateSpaceDialog.tsx'),
    ).toBeNull();
  });

  it('does not recurse into the override module (fallback import)', () => {
    expect(
      resolve(
        '../vendor/ui-space/src/components/DirectoryField',
        'src/app/native-directory-field.tsx',
      ),
    ).toBeNull();
  });
});
