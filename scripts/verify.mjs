#!/usr/bin/env node
/**
 * Static validation for the built self-contained Space plugin package.
 *
 * Checks the pieces the DSH profile loader and the browser module system
 * consume: manifest declarations, bundle patch, display resources, the
 * generated client registration and its external requests, the compiled Host
 * half (SQLite + RPC), and the fact that all Space sources live in this
 * repository. It does not render the UI; live verification runs through the
 * Harness inspection tools and the running page.
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
check(pkg.name === '@alter-dsh/space', 'package name must be @alter-dsh/space');
check(Boolean(pkg.version), 'package version is required');
check(pkg.type === 'module', 'package must be an ES module');
check(
  pkg.exports?.['.'] === './lib/host/index.js',
  'exports(".") must point at the compiled Host half',
);
check(
  pkg.exports?.['./client'] === './client.js',
  'exports("./client") must point at client.js',
);
check(
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'dsh.bundle.patch must point at cordis.patch.yml',
);
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web');
check(
  pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-connection'),
  'dsh.client.inject must include @deepseek-ai/dsh-client-connection',
);
for (const resource of ['client.js', 'cordis.patch.yml', 'icon.svg']) {
  check(
    pkg.files?.includes(resource) ||
      pkg.files?.some((file) => file.startsWith(resource.split('/')[0])),
    `files must include ${resource}`,
  );
}
check(pkg.files?.some((file) => file.startsWith('lib')), 'files must include lib/');
check(
  (await readdir(pluginRoot)).includes('index.js') === false,
  'the JavaScript Host entry index.js must not sit at the package root',
);

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

// Space source directories that must exist in this package.
const sourceDirs = [
  'client-modules',
  'mock-workbench',
  'protocol',
  'service',
  'ui-settings',
  'ui-space',
  'ui-system',
  'ui-workbench',
];
for (const name of sourceDirs) {
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
check(
  (
    await readdir(path.join(pluginRoot, 'vendor', 'ui-settings', 'src'), {
      recursive: true,
    })
  ).includes('SettingsPage.tsx'),
  'vendor/ui-settings/src must contain the settings page source',
);
check(
  (
    await readdir(path.join(pluginRoot, 'vendor', 'service', 'src'), {
      recursive: true,
    })
  ).includes('service.ts'),
  'vendor/service/src must contain the Space business service',
);

// --- Host half -------------------------------------------------------------
const hostEntry = 'lib/host/index.js';
const host = await read(hostEntry);
const hostSyntax = spawnSync(
  process.execPath,
  ['--check', path.join(pluginRoot, hostEntry)],
  { encoding: 'utf8' },
);
check(hostSyntax.status === 0, `node --check ${hostEntry} failed: ${hostSyntax.stderr.trim()}`);
const hostRpc = await read('lib/host/rpc.js');
check(
  hostRpc.includes('/api/alter-space') && hostRpc.includes('alter-space'),
  'Host half must register the /api/alter-space fetch route',
);
check(
  host.includes('connection') && host.includes('fetch'),
  'Host half must register through ctx.connection.fetch',
);
for (const fragment of ['space.db', 'node:sqlite']) {
  const storeFile = await read('lib/host/store.js');
  check(
    storeFile.includes(fragment),
    `compiled store must carry ${JSON.stringify(fragment)}`,
  );
}
const hostFiles = await readdir(path.join(pluginRoot, 'lib'), {
  recursive: true,
});
const hostScripts = hostFiles
  .filter((file) => file.endsWith('.js'))
  .map((file) => path.join(pluginRoot, 'lib', file));
for (const script of hostScripts) {
  const text = await readFile(script, 'utf8');
  check(
    !text.includes('from "@alter/') && !text.includes("from '@alter/"),
    `${path.relative(pluginRoot, script)} must not import @alter runtime code`,
  );
  for (const match of text.matchAll(/from "([^"]+)"/g)) {
    const specifier = match[1];
    check(
      specifier.startsWith('node:') ||
        specifier.startsWith('./') ||
        specifier.startsWith('../'),
      `${path.relative(pluginRoot, script)} imports unexpected module ${specifier}`,
    );
  }
}
for (const fragment of ['storage.get', 'storage.set', 'storage.estimate']) {
  check(
    (await read('lib/host/rpc.js')).includes(fragment),
    `compiled RPC must carry ${fragment}`,
  );
}
check(
  hostFiles.includes('host/storage.js') && hostFiles.includes('host/backup.js'),
  'compiled Host half must carry the storage controller and snapshot scheduler',
);
notes.push(`host scripts: ${String(hostScripts.length)}`);

// --- Client half -----------------------------------------------------------
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
  { encoding: 'utf8' },
);
check(syntax.status === 0, `node --check failed: ${syntax.stderr.trim()}`);

const escaped = client.endsWith('\n') ? client : `${client}\n`;
check(
  escaped.includes('--alter-surface'),
  'stylesheet must carry the Space design tokens',
);
check(
  escaped.includes('--alter-space-sidebar-width'),
  'stylesheet must carry the Space app styles',
);
check(
  escaped.includes('alter-space-host'),
  'stylesheet must carry the host fit rules',
);
check(
  escaped.includes('AI 协作者') &&
    escaped.includes('新建协作者') &&
    escaped.includes('创建协作者') &&
    escaped.includes('使用的模型'),
  'client bundle must carry the collaborator roster and its creation dialog',
);
check(
  escaped.includes('#/settings') && escaped.includes('返回空间'),
  'client bundle must carry the in-panel settings route and its back control',
);
check(
  escaped.includes('结构化文档') &&
    escaped.includes('data-doc-format') &&
    escaped.includes('重新加载'),
  'client bundle must carry the structured document editor',
);
check(
  escaped.includes('doc.get') &&
    escaped.includes('doc.undo') &&
    escaped.includes('doc.applyOps'),
  'client bundle must map the document model endpoints',
);
check(
  escaped.includes('/api/alter-space/asset'),
  'client bundle must render images through the authenticated asset route',
);

check(
  !/(^|[}])\s*kbd\s*\{/.test(escaped),
  'bare kbd selectors from copied CSS must stay scoped to the host container',
);
check(
  escaped.includes('存储与备份') &&
    escaped.includes('版本历史') &&
    escaped.includes('每日快照') &&
    escaped.includes('预计上限'),
  'client bundle must carry the storage policy settings UI',
);
check(
  escaped.includes('min-height:48px') &&
    escaped.includes('container-type:inline-size'),
  'stylesheet must carry the settings page row and container layout',
);
check(
  !escaped.includes('alter-space-settings-scroll') &&
    !escaped.includes('创建与设置已移到空间详情'),
  'the reused two-column settings composition must stay removed',
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
  escaped.includes('alter-space'),
  'client bundle must reference the /alter-space RPC channel',
);
check(
  escaped.includes('data-directory-picker') &&
    escaped.includes('directory-picker-unavailable'),
  'client bundle must route working-directory picking through the native picker override',
);
// The legacy HTML editor keeps silent autosave; the structured editor saves
// explicitly and may show its own save status, so only the failure affordance
// is asserted here.
check(
  escaped.includes('保存失败'),
  'the hosted editor must still surface a save-failure affordance',
);
check(
  escaped.includes('保存失败'),
  'the hosted editor must still surface a save-failure affordance',
);
check(
  !escaped.includes('createSpaceService'),
  'client bundle must not carry the removed in-browser data layer',
);


const bytes = Buffer.byteLength(client);
notes.push(`client.js size: ${(bytes / 1024).toFixed(0)} KiB`);

if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS');
for (const note of notes) console.log(`- ${note}`);
