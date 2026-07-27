// What counts as recover leaving its jurisdiction. The git plumbing around this
// (snapshot, revert) is a thin shell over `git`; the judgement it wraps is here,
// and it is the half that decides whether a campaign reverts an innocent
// environment fix or lets an unreviewed product edit reach the gate.

import { describe, expect, test } from 'bun:test';
import { breachedModules, outOfBounds } from './jurisdiction.ts';

// `git status --porcelain` lines: two status columns, a space, then the path.
const clean: string[] = [];

describe('outOfBounds', () => {
  test('a tracked source file recover modified is out of bounds', () => {
    expect(outOfBounds(clean, [' M src/auth/token.ts'], [])).toEqual(['src/auth/token.ts']);
  });

  test('untracked files are in bounds — a scratch reproduction is how a fault gets diagnosed', () => {
    expect(outOfBounds(clean, ['?? repro.ts', '?? /tmp-notes.md'], [])).toEqual([]);
  });

  test('manifests and lockfiles are in bounds — an install is a manifest edit', () => {
    expect(outOfBounds(clean, ['M  package.json', 'M  bun.lock'], [])).toEqual([]);
  });

  test("the campaign's own state is in bounds", () => {
    expect(outOfBounds(clean, ['M  .ailoop/campaign/backlog.json'], [])).toEqual([]);
  });

  test('dirt that was already there stays its owner\'s — the dirty-mainline anomaly IS pre-existing dirt', () => {
    const before = ['UU src/merge/conflicted.ts'];
    expect(outOfBounds(before, [...before], [])).toEqual([]);
  });

  test('clearing pre-existing dirt is never a violation', () => {
    expect(outOfBounds(['UU src/merge/conflicted.ts'], clean, [])).toEqual([]);
  });

  test('a fresh edit alongside pre-existing dirt is caught, and only that edit', () => {
    const before = ['UU src/merge/conflicted.ts'];
    const after = [...before, ' M src/auth/token.ts'];
    expect(outOfBounds(before, after, [])).toEqual(['src/auth/token.ts']);
  });

  test('a committed change is out of bounds even with a clean working tree', () => {
    expect(outOfBounds(clean, clean, ['src/auth/token.ts'])).toEqual(['src/auth/token.ts']);
  });

  test('a path both committed and dirty is reported once', () => {
    expect(outOfBounds(clean, ['M  src/a.ts'], ['src/a.ts'])).toEqual(['src/a.ts']);
  });

  test('a rename reports the destination it wrote, not the source it left', () => {
    expect(outOfBounds(clean, ['R  src/old.ts -> src/new.ts'], [])).toEqual(['src/new.ts']);
  });

  test('a quoted path is unwrapped', () => {
    expect(outOfBounds(clean, ['M  "src/odd name.ts"'], [])).toEqual(['src/odd name.ts']);
  });

  test('an ignored-file line is not a tracked change', () => {
    expect(outOfBounds(clean, ['!! dist/bundle.js'], [])).toEqual([]);
  });
});

describe('breachedModules', () => {
  test('a breach declares the directories it touched, deduped', () => {
    expect(breachedModules(['src/auth/token.ts', 'src/auth/session.ts', 'src/tui/pane.tsx']))
      .toEqual(['src/auth', 'src/tui']);
  });

  test('a repo-root file declares the root the way a ticket spells it', () => {
    expect(breachedModules(['build.ts'])).toEqual(['.']);
  });
});
