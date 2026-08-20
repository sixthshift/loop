// The destructive half of the boundary, against real repositories.
//
// `outOfBounds` decides what a breach IS and is unit-tested beside it; this file
// covers what the coordinator DOES about one — restore, untrack, reset — because
// those are irreversible, they run on the shared mainline, and a mistake here
// destroys work rather than merely failing a check. Each case builds a throwaway
// git repo, plays a recover run against it, and reads the tree back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { revertOutOfBounds, snapshotTree } from './jurisdiction.ts';
import type { Breach } from './jurisdiction.ts';

const git = (cmd: string) => execSync(`git ${cmd}`, { stdio: 'pipe' }).toString();

// A repository shaped like a project a campaign runs in: some source, a
// manifest, and campaign state kept out of git.
function inRepo(body: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-jurisdiction-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    git('init -q -b main .');
    git('config user.email loop@test && git config user.name loop');
    fs.mkdirSync('src');
    fs.writeFileSync('src/a.ts', 'export const a = 1;\n');
    fs.writeFileSync('package.json', '{"name":"x"}\n');
    fs.writeFileSync('.gitignore', '.ailoop/\n');
    git('add -A && git commit -qm base');
    fs.mkdirSync('.ailoop/campaign', { recursive: true });
    fs.writeFileSync('.ailoop/campaign/backlog.json', JSON.stringify({
      project: 't', mainline: 'main', tickets: [],
    }));
    body();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (p: string) => fs.readFileSync(p, 'utf8');
const porcelain = (p: string) => git(`status --porcelain ${p}`);

describe('an uncommitted breach', () => {
  test('reverts the product edit and nothing else', () => {
    inRepo(() => {
      const before = snapshotTree();

      fs.writeFileSync('src/a.ts', 'export const a = 999; // recover was here\n');
      fs.writeFileSync('package.json', '{"name":"x","deps":{}}\n'); // an install IS a manifest edit
      fs.writeFileSync('scratch-repro.ts', 'console.log(1)\n');     // untracked diagnosis
      fs.mkdirSync('.ailoop/campaign', { recursive: true });
      fs.writeFileSync('.ailoop/campaign/journal.jsonl', '{}\n');   // the campaign's own state
      fs.writeFileSync('src/b.ts', 'export const b = 2;\n');
      git('add src/b.ts');                                          // a NEW tracked file

      const breach = revertOutOfBounds(before);

      expect(breach.paths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(breach.reverted).toBe(true);
      expect(breach.diff).toContain('recover was here'); // captured before the undo
      expect(read('src/a.ts')).toBe('export const a = 1;\n');
      expect(read('package.json')).toContain('deps');
      expect(fs.existsSync('scratch-repro.ts')).toBe(true);
      expect(fs.existsSync('.ailoop/campaign/journal.jsonl')).toBe(true);
      // Untracked, not deleted: untracked is in bounds, and destroying content
      // nobody has read is not the coordinator's call.
      expect(fs.existsSync('src/b.ts')).toBe(true);
      expect(porcelain('src/b.ts').startsWith('??')).toBe(true);
    });
  });

  test('restores a tracked file the run deleted', () => {
    inRepo(() => {
      const before = snapshotTree();
      fs.rmSync('src/a.ts');
      const breach = revertOutOfBounds(before);
      expect(breach.paths).toEqual(['src/a.ts']);
      expect(read('src/a.ts')).toBe('export const a = 1;\n');
    });
  });
});

describe('a committed breach', () => {
  test('moves the mainline back to where the run found it', () => {
    inRepo(() => {
      const before = snapshotTree();
      fs.writeFileSync('src/a.ts', 'export const a = 42;\n');
      git('add -A && git commit -qm "recover fixed the bug"');
      expect(git('rev-parse HEAD').trim()).not.toBe(before.sha);

      const breach = revertOutOfBounds(before);

      expect(breach.paths).toEqual(['src/a.ts']);
      expect(breach.reverted).toBe(true);
      expect(git('rev-parse HEAD').trim()).toBe(before.sha);
      expect(read('src/a.ts')).toBe('export const a = 1;\n');
    });
  });

  test('refuses the reset when the repository tracks campaign state, and says the breach stands', () => {
    inRepo(() => {
      fs.mkdirSync('.ailoop/campaign', { recursive: true });
      fs.writeFileSync('.ailoop/campaign/backlog.json', '{"v":1,"mainline":"main"}\n');
      git('add -f .ailoop && git commit -qm "campaign state tracked"');

      const before = snapshotTree();
      fs.writeFileSync('src/a.ts', 'export const a = 7;\n');
      fs.writeFileSync('.ailoop/campaign/backlog.json', '{"v":2,"mainline":"main"}\n'); // this run's bookkeeping
      git('add -A && git commit -qm "recover edit + campaign write"');

      const breach = revertOutOfBounds(before);

      expect(breach.paths).toEqual(['src/a.ts']);
      expect(breach.reverted).toBe(false); // the caller owes the human a park
      // The undo would have rolled the ledger back to punish the run that wrote it.
      expect(JSON.parse(read('.ailoop/campaign/backlog.json')).v).toBe(2);
    });
  });
});

// Serial checkouts put ticket branches in the same working tree recover is
// trusted with, so HEAD itself is jurisdiction: a snapshot taken on a ticket
// branch would pin the wrong baseline, and a revert fired there would read
// the whole ticket diff as recover's breach.
describe('the pinned ref', () => {
  test('snapshot refuses to start anywhere but the recorded mainline', () => {
    inRepo(() => {
      git('checkout -q -b ailoop/T001');
      expect(() => snapshotTree()).toThrow(/HEAD is on ailoop\/T001, not main/);
    });
  });

  test('a run that wandered off the ref is put back before anything is measured', () => {
    inRepo(() => {
      const before = snapshotTree();
      git('checkout -q -b probe');
      fs.writeFileSync('src/a.ts', 'export const a = 5;\n');
      git('add -A && git commit -qm "probing on a branch"');

      const breach = revertOutOfBounds(before);

      expect(git('symbolic-ref --short HEAD').trim()).toBe('main');
      expect(breach.ref).toEqual({ expected: 'main', found: 'probe', restored: true });
      // The probe branch's commit is not mainline history — nothing to revert.
      expect(breach.paths).toEqual([]);
      expect(breach.reverted).toBe(true);
      expect(read('src/a.ts')).toBe('export const a = 1;\n');
    });
  });

  test('a return git refuses is a standing breach, not a guess', () => {
    inRepo(() => {
      const before = snapshotTree();
      git('checkout -q -b probe');
      fs.writeFileSync('src/a.ts', 'export const a = 5;\n');
      git('add -A && git commit -qm "probe commit"');
      fs.writeFileSync('src/a.ts', 'export const a = 6; // uncommitted on top\n');

      const breach = revertOutOfBounds(before);

      expect(breach.reverted).toBe(false);
      expect(breach.ref).toEqual({ expected: 'main', found: 'probe', restored: false });
      // Nothing was destroyed by the refusal — the tree recover left is intact
      // for the human the park hands it to.
      expect(read('src/a.ts')).toContain('uncommitted on top');
    });
  });
});

describe('a run that stayed in bounds', () => {
  test('an environment-only fix reports no breach', () => {
    inRepo(() => {
      const before = snapshotTree();
      fs.writeFileSync('untracked-note.md', 'diagnosis\n');
      expect(revertOutOfBounds(before)).toEqual({ paths: [], diff: '', reverted: true } satisfies Breach);
    });
  });

  test('dirt that was already there when the run started is left where it is', () => {
    inRepo(() => {
      fs.writeFileSync('src/a.ts', 'export const a = 1; // someone else was mid-edit\n');
      const before = snapshotTree();
      const breach = revertOutOfBounds(before);
      expect(breach.paths).toEqual([]);
      expect(read('src/a.ts')).toContain('someone else');
    });
  });
});
