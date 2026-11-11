/**
 * Build-time module override for the working-directory field.
 *
 * The Space UI views import `DirectoryField` in two places; this Vite
 * `resolveId` plugin redirects only those two import sites (`CreateSpaceDialog`
 * and `ConfigView`) to [`src/app/native-directory-field.tsx`](../src/app/native-directory-field.tsx),
 * which opens the host directory picker and keeps the built-in browser as
 * fallback.
 *
 * The override is intentionally narrow: every other import — including the
 * fallback import inside the override itself — resolves normally.
 */
import path from 'node:path';

/**
 * @param root - repository root (the plugin package root).
 * @returns the Vite plugin object.
 */
export function createDirectoryFieldOverride(root) {
  const vendorUiSpace = path.join(root, 'vendor', 'ui-space', 'src');
  const nativeField = path.join(root, 'src', 'app', 'native-directory-field.tsx');

  /** The two source import sites this override owns. */
  const redirects = new Map([
    [
      path.join(vendorUiSpace, 'components', 'CreateSpaceDialog.tsx'),
      { source: './DirectoryField' },
    ],
    [
      path.join(vendorUiSpace, 'views', 'ConfigView.tsx'),
      { source: '../components/DirectoryField' },
    ],
  ]);

  return {
    name: 'alter-space:native-directory-field',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const redirect = redirects.get(path.resolve(importer));
      if (redirect === undefined || redirect.source !== source) return null;
      return nativeField;
    },
  };
}
