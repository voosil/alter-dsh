/**
 * Build-time module override for the vendored document view.
 *
 * SpaceApp imports `./views/DocumentView`; this Vite `resolveId` plugin points
 * that import at the plugin-owned adaptive view, which keeps legacy HTML notes
 * on the vendored editor and routes AST documents to the structured renderer.
 * Every other import (including the adaptive view's own import of the vendored
 * view) resolves normally.
 */
import path from 'node:path';

/**
 * @param root - repository root (the plugin package root).
 * @returns the Vite plugin object.
 */
export function createDocumentViewOverride(root) {
  const spaceApp = path.join(root, 'vendor', 'ui-space', 'src', 'SpaceApp.tsx');
  const adaptiveView = path.join(
    root,
    'src',
    'document',
    'adaptive-document-view.tsx',
  );

  return {
    name: 'alter-space:document-view',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './views/DocumentView') return null;
      if (importer === undefined || importer === null) return null;
      if (path.resolve(importer) !== spaceApp) return null;
      return adaptiveView;
    },
  };
}
