#!/usr/bin/env node
/**
 * Build the self-contained Space client plugin bundle.
 *
 * The Space UI sources live under `vendor/` and the plugin seam lives in
 * `src/`; this script compiles the browser half into the DSH client bundle
 * format:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * Nothing outside this repository is read at build time.
 *
 * Steps:
 * 1. Vite library build (`src/entry.js`) with React/ReactDOM external, so the
 *    bundle resolves them through the host module table like shipped plugins.
 * 2. Collect the emitted stylesheet (Space + ui-system CSS modules, tokens).
 * 3. Wrap the CommonJS output in the module-loader registration, inlining the
 *    stylesheet and injecting it once with a `data-plugin-css` guard — the
 *    pattern shipped client plugins use.
 */
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createDirectoryFieldOverride } from './directory-field-override.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const vendor = path.join(pluginRoot, 'vendor');
const distDir = path.join(pluginRoot, 'dist');

const pkg = JSON.parse(
  await readFile(path.join(pluginRoot, 'package.json'), 'utf8'),
);

/** Source root of a package under vendor/, e.g. `vendorSrc('ui-space')`. */
const vendorSrc = (name) => path.join(vendor, name, 'src');

/** These packages keep their own source layout and relative imports. */
const alias = [
  {
    find: /^@alter\/ui-space\/(.*)$/,
    replacement: path.join(vendorSrc('ui-space'), '$1'),
  },
  {
    find: /^@alter\/ui-space$/,
    replacement: path.join(vendorSrc('ui-space'), 'index.ts'),
  },
  {
    find: /^@alter\/ui-system\/tokens\.css$/,
    replacement: path.join(vendorSrc('ui-system'), 'styles', 'tokens.css'),
  },
  {
    find: /^@alter\/ui-system$/,
    replacement: path.join(vendorSrc('ui-system'), 'index.ts'),
  },
  {
    // Plugin-owned document-runtime seam: the frozen document page keeps its
    // DOM/CSS and delegates saving, drafts, snapshots and HTML projection here.
    find: /^@alter-space\/document-runtime$/,
    replacement: path.join(
      pluginRoot,
      'src',
      'document',
      'runtime',
      'index.ts',
    ),
  },
  {
    // Kept resolvable: the panel renders its own settings page
    // (`src/settings/page.tsx`) because that page also owns the DSH-only
    // storage policy, so this source page is not mounted.
    find: /^@alter\/ui-settings\/SettingsPage$/,
    replacement: path.join(vendorSrc('ui-settings'), 'SettingsPage.tsx'),
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
];

const directoryFieldOverride = createDirectoryFieldOverride(pluginRoot);

await rm(distDir, { recursive: true, force: true });

await build({
  configFile: false,
  root: pluginRoot,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias },
  plugins: [directoryFieldOverride],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: process.env.SPACE_PLUGIN_UNMINIFIED ? false : 'oxc',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 1024 * 1024 * 1024,
    reportCompressedSize: false,
    lib: {
      entry: path.join(pluginRoot, 'src/entry.js'),
      formats: ['cjs'],
      fileName: () => 'client.bundle.cjs',
      cssFileName: 'client',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
  },
});

const emitted = await readdir(distDir);
const bundleFile = emitted.find((file) => file.endsWith('.cjs'));
const cssFile = emitted.find((file) => file.endsWith('.css'));
if (!bundleFile) throw new Error(`Vite emitted no CJS bundle: ${emitted}`);

const bundle = await readFile(path.join(distDir, bundleFile), 'utf8');

/**
 * Adapt the Space stylesheets to a panel inside the host document:
 * - the app measured itself against the viewport (`100dvh`); a panel is a flex
 *   item, so the percentage resolves against the panel box instead;
 * - `tokens.css` keeps `color-scheme: light` at the document root, which would
 *   force the whole host app light; the host container carries it instead;
 * - CSS Modules leaves element selectors unscoped; a bare `kbd` rule in copied
 *   styles would restyle the host's own <kbd>, so scope it to the container.
 */
function adaptCss(css) {
  return css
    .replaceAll('100dvh', '100%')
    .replace(/(:root[^{}]*\{[^}]*?)color-scheme:\s*light;?/g, '$1')
    .replace(/(^|[}])\s*kbd\s*\{/g, '$1.alter-space-host kbd{');
}

const css = cssFile
  ? adaptCss(await readFile(path.join(distDir, cssFile), 'utf8'))
  : '';

const header = `/* ${pkg.name} client bundle — generated by build/build.mjs; do not edit. */`;
const registration = `${header}
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tconst __dshCss = ${JSON.stringify(css)};
\t\tconst __dshCssTagId = ${JSON.stringify(`${pkg.name}/client.css`)};
\t\tif (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(__dshCssTagId) + ']') === null) {
\t\t\tconst __dshStyle = document.createElement('style');
\t\t\t__dshStyle.dataset.plugin = ${JSON.stringify(pkg.name)};
\t\t\t__dshStyle.dataset.pluginCss = __dshCssTagId;
\t\t\t__dshStyle.textContent = __dshCss;
\t\t\tdocument.head.appendChild(__dshStyle);
\t\t}
${bundle}
\t\treturn module.exports;
\t}
});
`;

const outFile = path.join(pluginRoot, 'client.js');
await writeFile(outFile, registration);
await rm(distDir, { recursive: true, force: true });

const sizeKb = (await readFile(outFile)).byteLength / 1024;
console.log(
  `built ${path.relative(pluginRoot, outFile)} (${sizeKb.toFixed(0)} KiB, ${css ? `${(css.length / 1024).toFixed(0)} KiB css` : 'no css'})`,
);
