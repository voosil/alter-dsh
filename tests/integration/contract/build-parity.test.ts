/**
 * Build-time wiring parity.
 *
 * The `@alter/*` aliases and the legacy adapter seam are declared in three
 * places (`build/build.mjs`, `tsconfig.json` paths, `vitest.config.mts`);
 * AGENTS.md requires them to stay in sync. `docs/specs/system-architecture.md` §5 records why.
 *
 * The Docker image compiles the Host half with the same `build:host` script, so
 * the deployment contract is pinned here too: `scripts/gate/verify.mjs` runs the
 * same static checks in `pnpm verify`, this file makes them fail in the test
 * gate even when the image is not built.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAYERS, LAYER_DEFINITIONS } from '../../layers.mjs';

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const readText = (relative: string): Promise<string> =>
  readFile(join(root, relative), 'utf8');

/** Normalise a Dockerfile/tsconfig path: drop `./`, leading `/` and trailing `/`. */
const normalizePath = (entry: string): string =>
  entry.replace(/^\.?\//, '').replace(/\/+$/, '');

interface DockerCopy {
  stage: string;
  from: string | null;
  sources: string[];
  destination: string;
}

/** Parse FROM/COPY instructions; comments and flags other than `--from` are ignored. */
function parseDockerfile(text: string): { stages: string[]; copies: DockerCopy[] } {
  const stages: string[] = [];
  const copies: DockerCopy[] = [];
  let stage = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from !== null) {
      stage = (from[1] ?? `stage-${String(stages.length + 1)}`).toLowerCase();
      stages.push(stage);
      continue;
    }
    if (!/^COPY\s/i.test(line)) continue;
    const tokens = line.slice(4).trim().split(/\s+/);
    const source = tokens[0]?.startsWith('--from=') === true
      ? tokens.shift()?.slice('--from='.length) ?? null
      : null;
    const destination = normalizePath(tokens.pop() ?? '');
    copies.push({
      stage,
      from: source,
      sources: tokens.map(normalizePath),
      destination,
    });
  }
  return { stages, copies };
}

interface DockerParity {
  dockerfile: string;
  dockerignore: string[];
  pkg: {
    scripts?: Record<string, string>;
    bin?: string | Record<string, string>;
  };
  hostTsconfig: { include?: string[] };
  stages: string[];
  copies: DockerCopy[];
}

async function loadDockerParity(): Promise<DockerParity> {
  const [dockerfile, dockerignore, pkgText, hostTsconfigText] = await Promise.all([
    readText('Dockerfile'),
    readText('.dockerignore'),
    readText('package.json'),
    readText('tsconfig.host.json'),
  ]);
  return {
    dockerfile,
    dockerignore: dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
    pkg: JSON.parse(pkgText) as DockerParity['pkg'],
    hostTsconfig: JSON.parse(hostTsconfigText) as DockerParity['hostTsconfig'],
    ...parseDockerfile(dockerfile),
  };
}

describe('Docker deployment parity', () => {
  it('copies every build:host input into the build stage', async () => {
    const parity = await loadDockerParity();
    const buildStage = parity.stages.includes('build')
      ? 'build'
      : parity.stages[0];
    const buildCopies = parity.copies.filter(
      (copy) => copy.stage === buildStage && copy.from === null,
    );
    const inputs = new Set([
      'package.json',
      'pnpm-lock.yaml',
      ...(String(parity.pkg.scripts?.['build:host'] ?? '').match(
        /[\w@./-]+\.(?:json|mjs|cjs|ts|js)/g,
      ) ?? []),
      ...(parity.hostTsconfig.include ?? []).map((entry) => entry.split('/**')[0]),
    ]);
    for (const input of inputs) {
      const normalized = normalizePath(input);
      const covered = buildCopies.some((copy) =>
        copy.sources.some(
          (source) =>
            source === '.' ||
            normalized === source ||
            normalized.startsWith(`${source}/`),
        ),
      );
      expect(covered, `${normalized} must be COPYed into the build stage`).toBe(true);
      const ignored = parity.dockerignore.some(
        (pattern) =>
          !/[*?[\]]/.test(pattern) &&
          (normalized === normalizePath(pattern) ||
            normalized.startsWith(`${normalizePath(pattern)}/`)),
      );
      expect(ignored, `.dockerignore must not exclude ${normalized}`).toBe(false);
      await expect(stat(join(root, normalized))).resolves.toBeDefined();
    }
  });

  it('keeps ENTRYPOINT equal to package.json bin and scripts.server', async () => {
    const parity = await loadDockerParity();
    const line = parity.dockerfile
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => /^ENTRYPOINT\s/i.test(entry));
    expect(line).toBeDefined();
    const payload = (line as string).replace(/^ENTRYPOINT\s+/i, '');
    const args = payload.startsWith('[')
      ? (JSON.parse(payload) as string[])
      : payload.split(/\s+/);
    const target = normalizePath(args[args.length - 1] ?? '');
    const bin =
      typeof parity.pkg.bin === 'string'
        ? parity.pkg.bin
        : (Object.values(parity.pkg.bin ?? {})[0] ?? '');
    expect(target).toBe(normalizePath(bin));
    expect(target).toBe(
      normalizePath(String(parity.pkg.scripts?.server ?? '').split(/\s+/).pop() ?? ''),
    );
    // The entrypoint must be the compiled form of a real TypeScript source,
    // and that source must stay inside the host tsconfig include.
    const source = target.replace(/^lib\//, '').replace(/\.js$/, '.ts');
    await expect(stat(join(root, source))).resolves.toBeDefined();
    const includeRoots = (parity.hostTsconfig.include ?? []).map((entry) =>
      normalizePath(entry.split('/**')[0]),
    );
    expect(
      includeRoots.some(
        (rootPath) => source === rootPath || source.startsWith(`${rootPath}/`),
      ),
      `${source} must be covered by tsconfig.host.json`,
    ).toBe(true);
  });

  it('keeps a non-root, healthchecked runtime that only carries lib/ and package.json', async () => {
    const parity = await loadDockerParity();
    const runtimeStage = parity.stages[parity.stages.length - 1];
    expect(parity.stages.length).toBeGreaterThanOrEqual(2);
    const runtimeCopies = parity.copies.filter(
      (copy) => copy.stage === runtimeStage,
    );
    for (const copy of runtimeCopies) {
      for (const source of copy.sources) {
        expect(
          ['app/lib', 'app/package.json'],
          `runtime stage must not carry build-only files (${source})`,
        ).toContain(source);
      }
    }
    expect(
      runtimeCopies.some(
        (copy) => copy.destination === 'lib' && copy.sources.includes('app/lib'),
      ),
    ).toBe(true);
    expect(/^USER\s+node\s*$/m.test(parity.dockerfile)).toBe(true);
    expect(/^HEALTHCHECK\b/m.test(parity.dockerfile)).toBe(true);
  });
});

describe('module alias parity', () => {
  /**
   * The alias name appears as a regex source in build/vitest
   * (`/^@alter-space\/document-runtime$/`) and as a literal key in tsconfig
   * (`"@alter-space/document-runtime"`), so compare the unescaped form.
   */
  const ALIAS = '@alter-space/document-runtime';
  const unescape = (text: string): string => text.replace(/\\\//g, '/');

  it('declares the document-runtime seam in build, tsconfig and vitest', async () => {
    const [build, tsconfig, vitest] = await Promise.all([
      readFile(join(root, 'build', 'build.mjs'), 'utf8'),
      readFile(join(root, 'tsconfig.json'), 'utf8'),
      readFile(join(root, 'vitest.config.mts'), 'utf8'),
    ]);
    const expectedSegments = ['src', 'document', 'runtime', 'index.ts'];
    for (const [name, text] of [
      ['build/build.mjs', build],
      ['tsconfig.json', tsconfig],
      ['vitest.config.mts', vitest],
    ] as const) {
      const source = unescape(text);
      expect(source, name).toContain(ALIAS);
      const normalized = source.replace(/['",\s]/g, '/');
      for (const segment of expectedSegments) expect(normalized, `${name}: ${segment}`).toContain(segment);
    }
  });

  it('keeps the directory-field override out of the plain module graph', async () => {
    const build = await readFile(join(root, 'build', 'build.mjs'), 'utf8');
    const override = await readFile(join(root, 'build', 'directory-field-override.mjs'), 'utf8');
    expect(build).toContain('createDirectoryFieldOverride');
    expect(override).toContain('CreateSpaceDialog.tsx');
    expect(override).toContain('ConfigView.tsx');
  });
});

describe('test layer wiring', () => {
  it('gives every layer an include glob under its own directory', () => {
    for (const layer of LAYERS) {
      const definition = LAYER_DEFINITIONS[layer];
      expect(definition, layer).toBeDefined();
      for (const glob of definition.include) {
        expect(glob, layer).toMatch(new RegExp(`^tests/${layer}/`));
      }
    }
  });
});