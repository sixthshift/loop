// The footprint predicates are pure (moduleErrors aside, which consults the
// real tree for paths that already exist), so they are asserted directly rather
// than through a scratch campaign. Paths that must exist on disk are this
// repository's own — the suite runs from the repository root.

import { describe, expect, test } from 'bun:test';
import { isInside, isManifest, moduleErrors, modulesCollide, normalizeModule, ROOT } from './footprint.ts';

describe('normalizeModule', () => {
  test('a leading ./ or /, a trailing /, and doubled slashes all wash out', () => {
    for (const raw of ['src/auth', './src/auth', '/src/auth', 'src/auth/', ' src//auth/ ']) {
      expect(normalizeModule(raw)).toBe('src/auth');
    }
  });

  test('. and / are the repository root', () => {
    expect(normalizeModule('.')).toBe(ROOT);
    expect(normalizeModule('/')).toBe(ROOT);
  });

  test('an escaping segment survives normalization so validation can see it', () => {
    expect(normalizeModule('../elsewhere')).toBe('../elsewhere');
  });
});

describe('isInside', () => {
  test('a file the decomposer never foresaw is in scope when it lands in the module', () => {
    expect(isInside('src/auth/token-rotation.ts', 'src/auth')).toBe(true);
  });

  test('a sibling sharing a name prefix is outside', () => {
    expect(isInside('src/authz/policy.ts', 'src/auth')).toBe(false);
  });

  test('the repository root holds everything', () => {
    expect(isInside('anywhere/at/all.ts', ROOT)).toBe(true);
  });

  test('a path above the module is outside', () => {
    expect(isInside('src/index.ts', 'src/auth')).toBe(false);
  });
});

describe('modulesCollide', () => {
  test('nesting collides in both directions', () => {
    expect(modulesCollide('src', 'src/auth')).toBe(true);
    expect(modulesCollide('src/auth', 'src')).toBe(true);
  });

  test('disjoint siblings do not collide', () => {
    expect(modulesCollide('src/auth', 'src/api')).toBe(false);
  });
});

describe('isManifest', () => {
  test('a manifest is recognised by basename, however deep it sits', () => {
    expect(isManifest('apps/web/package.json')).toBe(true);
    expect(isManifest('bun.lock')).toBe(true);
    expect(isManifest('src/auth/config.json')).toBe(false);
  });
});

describe('moduleErrors', () => {
  test('an existing directory is a valid module', () => {
    expect(moduleErrors(['src/campaign'])).toEqual([]);
  });

  test('an unknown but directory-shaped path is valid — modules may not exist yet', () => {
    expect(moduleErrors(['src/auth', 'test/auth'])).toEqual([]);
  });

  test('a missing declaration is refused', () => {
    expect(moduleErrors([])).toHaveLength(1);
    expect(moduleErrors(undefined)).toHaveLength(1);
  });

  test('a path that exists as a file is refused whatever it looks like', () => {
    expect(moduleErrors(['src/campaign/verify.ts'])[0]).toContain('names a file');
    expect(moduleErrors(['LICENSE'])[0]).toContain('names a file');
  });

  test('a file-shaped path is refused even when nothing is there yet', () => {
    expect(moduleErrors(['src/auth/service.ts'])[0]).toContain('names a file');
  });

  test('a dotfile-named directory is not mistaken for a file', () => {
    expect(moduleErrors(['.github/workflows'])).toEqual([]);
  });

  test('a module escaping the repository is refused', () => {
    expect(moduleErrors(['../elsewhere'])[0]).toContain('escapes the repository');
  });

  test('every bad entry reports, not just the first', () => {
    expect(moduleErrors(['src/a.ts', '../b', 'src/campaign'])).toHaveLength(2);
  });
});
