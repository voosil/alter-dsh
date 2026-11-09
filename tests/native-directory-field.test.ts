import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DirectoryField,
  DirectoryPickerProvider,
  appendPickedDirectory,
} from '../src/native-directory-field';
import { SpaceContext } from '../vendor/ui-space/src/runtime';
import type { SpaceContextValue } from '../vendor/ui-space/src/runtime';

/** The built-in fallback only reads `service.listDirectories` in effects. */
const fallbackContext = {
  service: { listDirectories: async () => ({ path: '~', entries: [] }) },
} as unknown as SpaceContextValue;

function render(
  pickDirectory: (() => Promise<string | null>) | undefined,
  directories: string[] = [],
) {
  return renderToStaticMarkup(
    createElement(
      SpaceContext.Provider,
      { value: fallbackContext },
      createElement(
        DirectoryPickerProvider,
        { pickDirectory },
        createElement(DirectoryField, { directories, onChange: () => {} }),
      ),
    ),
  );
}

describe('native directory field', () => {
  it('renders the host-picker variant with the selected directories', () => {
    const html = render(async () => '/Users/me/work', [
      '/Users/me/work',
      '~/reference',
    ]);
    expect(html).toContain('data-directory-picker="native"');
    expect(html).toContain('>选择资料库<');
    expect(html).not.toContain('>选择工作区<');
    expect(html).toContain('/Users/me/work');
    expect(html).toContain('~/reference');
    expect(html).toContain('工作目录可编辑和读写，其他目录将作为资料库来源');
    expect(html).toContain('移除 /Users/me/work');
    // The built-in in-app browser must not render on the native path.
    expect(html).not.toContain('可以选择多个目录');
  });

  it('falls back to the built-in browser when the host has no picker', () => {
    const html = render(undefined);
    expect(html).not.toContain('data-directory-picker="native"');
    expect(html).toContain('可以选择多个目录');
  });

  it('labels the first pick as the working area picker', () => {
    const html = render(async () => null);
    expect(html).toContain('data-directory-picker="native"');
    expect(html).toContain('>选择工作区<');
    expect(html).not.toContain('>选择资料库<');
    expect(html).not.toContain('已选目录');
    expect(html).toContain('工作目录可编辑和读写，其他目录将作为资料库来源');
  });
});

describe('appendPickedDirectory', () => {
  it('appends a trimmed path', () => {
    expect(appendPickedDirectory([], '  /Users/me/next  ')).toEqual([
      '/Users/me/next',
    ]);
  });

  it('ignores empty paths and duplicates', () => {
    const current = ['/Users/me/work'];
    expect(appendPickedDirectory(current, '   ')).toBe(current);
    expect(appendPickedDirectory(current, '/Users/me/work')).toBe(current);
  });
});
