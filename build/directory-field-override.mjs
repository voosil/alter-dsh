/**
 * Build-time module override for the vendored working-directory field.
 *
 * The Space UI is a byte-identical copy of the upstream Alter sources, so the
 * DSH port may not edit `vendor/ui-space/src/components/DirectoryField.tsx`
 * in place. Instead this Vite `resolveId` plugin redirects only the two
 * vendored import sites of that component (`CreateSpaceDialog` and
 * `ConfigView`) to the port-owned
 * [`src/native-directory-field.tsx`](../src/native-directory-field.tsx), which
 * opens the host directory picker and keeps the vendored browser as fallback.
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
  const nativeField = path.join(root, 'src', 'native-directory-field.tsx');

  /** The two vendored import sites this override owns. */
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
