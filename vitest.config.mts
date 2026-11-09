import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
/** Source root of a package under vendor/, e.g. `vendorSrc('ui-settings')`. */
const vendorSrc = (name: string) => path.join(root, 'vendor', name, 'src');

export default defineConfig({
  // Tests import the Space/business packages by their `@alter/*` names;
  // mirror the build's aliases so unit tests exercise the same sources the
  // client bundle compiles.
  resolve: {
    alias: [
      {
        find: /^@alter\/ui-space\/(.*)$/,
        replacement: path.join(vendorSrc('ui-space'), '$1'),
      },
      {
        find: /^@alter\/ui-space$/,
        replacement: path.join(vendorSrc('ui-space'), 'index.ts'),
      },
      {
        find: /^@alter\/ui-settings\/SettingsPage$/,
        replacement: path.join(vendorSrc('ui-settings'), 'SettingsPage.tsx'),
      },
      {
        find: /^@alter\/ui-system$/,
        replacement: path.join(vendorSrc('ui-system'), 'index.ts'),
      },
      {
        find: /^@alter\/ui-workbench$/,
        replacement: path.join(vendorSrc('ui-workbench'), 'index.ts'),
      },
      {
        find: /^@alter\/mock-workbench$/,
        replacement: path.join(vendorSrc('mock-workbench'), 'index.ts'),
      },
      {
        find: /^@alter\/protocol$/,
        replacement: path.join(vendorSrc('protocol'), 'index.ts'),
      },
      {
        find: /^@alter\/client-modules$/,
        replacement: path.join(vendorSrc('client-modules'), 'index.ts'),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
