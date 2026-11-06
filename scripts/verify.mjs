#!/usr/bin/env node
/**
 * Static validation for the built self-contained Space plugin package.
 *
 * This checks the pieces the DSH profile loader and the browser module system
 * consume: the manifest declarations, the bundle patch, display resources, the
 * generated loader registration, the external module requests, and the fact
 * that the vendored Space sources are actually part of this repository. It does
 * not render the UI; live verification runs through the Harness inspection
 * tools.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const read = (relative) => readFile(path.join(pluginRoot, relative), 'utf8');

const pkg = JSON.parse(await read('package.json'));
check(
  pkg.name === '@alter-dsh/space',
  'package name must be @alter-dsh/space',
);
check(Boolean(pkg.version), 'package version is required');
check(pkg.type === 'module', 'package must be an ES module');
check(
  pkg.exports?.['./client'] === './client.js',
  'exports("./client") must point at client.js',
);
check(
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'dsh.bundle.patch must point at cordis.patch.yml',
);
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web');
for (const resource of [
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'icon.svg',
]) {
  check(
    pkg.files?.includes(resource) ||
      pkg.files?.some((file) => file.startsWith(resource.split('/')[0])),
    `files must include ${resource}`,
  );
}

const patch = await read('cordis.patch.yml');
check(
  patch.includes(`'${pkg.name}'`),
  `cordis.patch.yml must insert the ${pkg.name} row`,
);
check(patch.includes('insert:'), 'cordis.patch.yml must use the insert form');

for (const locale of ['en', 'zh']) {
  const dictionary = JSON.parse(await read(`locale/${locale}.json`));
  check(
    Boolean(dictionary.meta?.title),
    `locale/${locale}.json needs meta.title`,
  );
  check(
    Boolean(dictionary.meta?.description),
    `locale/${locale}.json needs meta.description`,
  );
}

const icon = await stat(path.join(pluginRoot, 'icon.svg'));
check(
  icon.size > 0 && icon.size < 256 * 1024,
  'icon must be a non-empty image below 256 KiB',
);

// The feature must be carried by this repository, not by an external checkout.
const vendored = [
  'client-modules',
  'mock-space',
  'mock-workbench',
  'protocol',
  'ui-space',
  'ui-system',
  'ui-workbench',
];
for (const name of vendored) {
  let files = [];
  try {
    files = await readdir(path.join(pluginRoot, 'vendor', name, 'src'), {
      recursive: true,
    });
  } catch {
    check(false, `vendor/${name}/src must exist`);
    continue;
  }
  check(files.length > 0, `vendor/${name}/src must contain source files`);
}
check(
  (
    await readdir(path.join(pluginRoot, 'vendor', 'ui-space', 'src'), {
      recursive: true,
    })
  ).includes('SpaceApp.tsx'),
  'vendor/ui-space/src must carry the Space application entry',
);

const client = await read('client.js');
check(
  client.includes('window.__ModuleLoader__.load('),
  'client.js must register through window.__ModuleLoader__.load',
);
check(
  new RegExp(
    `id:\\s*${JSON.stringify(pkg.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  ).test(client),
  `loader id must equal the package name (${pkg.name})`,
);
check(
  /factory:\s*\(require\)\s*=>/.test(client),
  'client.js must expose a lazy factory(require)',
);
check(/exports\.apply\s*=/.test(client), 'client.js must export apply');
check(/exports\.inject\s*=/.test(client), 'client.js must export inject');
check(
  /data-plugin-css/.test(client),
  'client.js must inject its stylesheet with the data-plugin-css guard',
);

const allowedExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]);
const requests = [...client.matchAll(/require\("([^"]+)"\)/g)].map(
  (match) => match[1],
);
for (const request of new Set(requests)) {
  check(
    allowedExternals.has(request),
    `unexpected external module request: ${request}`,
  );
}
notes.push(
  `external module requests: ${[...new Set(requests)].join(', ') || 'none'}`,
);

// The wrapper must be a classic script: no top-level ESM import/export left.
check(
  !/^\s*(import|export)\s/m.test(client),
  'client.js must be a plain script without top-level import/export',
);

const syntax = spawnSync(
  process.execPath,
  ['--check', path.join(pluginRoot, 'client.js')],
  {
    encoding: 'utf8',
  },
);
check(syntax.status === 0, `node --check failed: ${syntax.stderr.trim()}`);

// Feature evidence: tokens, the Space module itself, the data layer and the
// host fit, all bundled locally.
const escaped = client.endsWith('\n') ? client : `${client}\n`;
check(
  escaped.includes('--alter-surface'),
  'stylesheet must carry the Space design tokens',
);
check(
  escaped.includes('--alter-space-sidebar-width'),
  'stylesheet must carry the ported Space app styles',
);
check(
  escaped.includes('alter-space-host'),
  'stylesheet must carry the host fit rules',
);
check(
  escaped.includes('.alter-space-host kbd'),
  'bare kbd selector from the copied CSS must be scoped to the host container',
);
check(
  !escaped.includes('100dvh'),
  'viewport-sized rules from the copied CSS must be rebased onto the panel box',
);
check(
  !/:root,:root\[data-theme=light\]\{[^}]*color-scheme/.test(escaped),
  'color-scheme must not leak to the document root',
);
check(
  escaped.includes('alter.space.mock.v4'),
  'bundle must carry the vendored Space data layer',
);

// Self-containment: no build/source file may point back at another checkout.
// The needle is assembled at runtime so this file does not match itself.
const foreignCheckout = ['', 'workspace', 'indie', 'Alter', ''].join('/');
const localSources = [
  'build/build.mjs',
  'index.js',
  'scripts/verify.mjs',
  'src/entry.js',
  'src/plugin-data.js',
  'src/router.js',
  'src/minimal-seed.js',
];
for (const file of localSources) {
  const text = await read(file);
  check(
    !text.includes(foreignCheckout),
    `${file} must not reference another checkout by absolute path`,
  );
}

const bytes = Buffer.byteLength(client);
notes.push(`client.js size: ${(bytes / 1024).toFixed(0)} KiB`);

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS');
for (const note of notes) console.log(`- ${note}`);
