// The serial checkout lifecycle, against real repositories. The properties
// under test live in git's behaviour, not in a pure fold: what `create`
// refuses (and why the refusal is what makes `discard`'s clean safe), what
// `discard` erases and what it spares, and what `land` will and won't
// fast-forward. Each case builds a throwaway repository and reads back what
// the next verb — or the human — would find.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { createBranch, attachBranch, discardCheckout, landBranch, mainSha } from './branch.ts';

const git = (cmd: string, cwd?: string) => execSync(`git ${cmd}`, { stdio: 'pipe', cwd }).toString();

const head = () => git('symbolic-ref --short HEAD').trim();

// A repository with a recorded campaign: tracked source, ignored dependency
// and build trees, and the `.ailoop/` state the mainline stamp lives in.
function inRepo(body: (repo: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-branch-'));
  const repo = fs.realpathSync(dir); // macOS hands out /var → /private/var symlinks; git reports the real path
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    git('init -q -b main .');
    git('config user.email loop@test && git config user.name loop');
    fs.writeFileSync('.gitignore', 'node_modules/\ndist/\n.ailoop/\n');
    fs.mkdirSync('src', { recursive: true });
    fs.writeFileSync('src/a.ts', 'export const a = 1;\n');
    git('add -A && git commit -qm base');
    write('node_modules/dep/index.js', 'module.exports = 1;\n');
    write('dist/bundle.js', 'built\n');
    write('.ailoop/campaign/backlog.json', JSON.stringify({
      project: 't', mainline: 'main', tickets: [],
    }));
    body(repo);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, content);
}

// One commit's worth of work, as a worker leaves it.
const workOn = (id: string): void => {
  const cut = createBranch(id);
  if (!cut.ok) throw new Error(`workOn: ${cut.reason}`);
  fs.writeFileSync('src/a.ts', `export const a = '${id}';\n`);
  git('add -A && git commit -qm "feat: work for the ticket"');
};

describe('cutting a ticket branch', () => {
  test('create cuts from mainline, checks it out, and reports the base', () => {
    inRepo(() => {
      const cut = createBranch('T001');
      expect(cut).toEqual({ ok: true, branch: 'ailoop/T001', baseSha: git('rev-parse main').trim() });
      expect(head()).toBe('ailoop/T001');
    });
  });

  test('create refuses when another ticket holds the checkout', () => {
    inRepo(() => {
      createBranch('T001');
      const refused = createBranch('T002');
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain('HEAD is on ailoop/T001');
    });
  });

  test('create refuses an unclean tree and names the litter — ignored trees are not litter', () => {
    inRepo(() => {
      fs.writeFileSync('notes.txt', 'stray\n');
      const refused = createBranch('T001');
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.paths).toEqual(['notes.txt']); // node_modules/, dist/, .ailoop/ stay invisible
        expect(refused.reason).toContain('commit, stash, or gitignore');
      }
    });
  });

  test('a stale branch from a dead attempt does not block re-dispatch', () => {
    inRepo(() => {
      workOn('T001');
      discardCheckout();
      const again = createBranch('T001');
      expect(again).toMatchObject({ ok: true });
      // The replacement is cut from mainline, not resumed from the dead attempt.
      expect(git('log ailoop/T001 --pretty=%s').trim()).toBe('base');
    });
  });

  test('a worktree-era registration is pruned rather than pinning the branch', () => {
    inRepo(repo => {
      const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
      git(`worktree add -q -b ailoop/T009 "${wt}" HEAD`);
      fs.rmSync(wt, { recursive: true, force: true }); // dead run: dir gone, registration survives
      expect(createBranch('T009')).toMatchObject({ ok: true, branch: 'ailoop/T009' });
    });
  });
});

describe('discarding a rejected build', () => {
  test('erases worker litter, spares campaign state, returns to mainline, keeps the branch', () => {
    inRepo(() => {
      createBranch('T001');
      fs.writeFileSync('src/a.ts', 'export const a = 999;\n'); // tracked, modified
      fs.writeFileSync('junk.tmp', 'worker litter\n'); // untracked
      discardCheckout();
      expect(head()).toBe('main');
      expect(fs.readFileSync('src/a.ts', 'utf8')).toContain('a = 1');
      expect(fs.existsSync('junk.tmp')).toBe(false);
      expect(fs.existsSync('.ailoop/campaign/backlog.json')).toBe(true);
      expect(git('branch --list ailoop/T001').trim()).not.toBe('');
    });
  });

  test('staged-but-uncommitted litter is erased, not carried onto mainline', () => {
    inRepo(() => {
      createBranch('T001');
      fs.writeFileSync('src/a.ts', 'export const a = 999;\n');
      write('staged-new.txt', 'worker litter\n');
      git('add src/a.ts staged-new.txt'); // the worker staged and died before committing
      discardCheckout();
      expect(head()).toBe('main');
      expect(git('status --porcelain').trim()).toBe('');
      expect(fs.readFileSync('src/a.ts', 'utf8')).toContain('a = 1');
      expect(fs.existsSync('staged-new.txt')).toBe(false);
    });
  });

  test('clean-before-checkout: an untracked file shadowing a mainline path cannot block the return', () => {
    inRepo(() => {
      createBranch('T001');
      git('rm -q src/a.ts && git commit -qm "drop a"');
      write('src/a.ts', 'imposter\n'); // untracked here, tracked on main — checkout alone would refuse
      expect(discardCheckout()).toEqual({ mainline: 'main' });
      expect(head()).toBe('main');
      expect(fs.readFileSync('src/a.ts', 'utf8')).toContain('a = 1');
    });
  });
});

describe('landing a ticket', () => {
  test('fast-forwards mainline onto the branch — no merge commit', () => {
    inRepo(() => {
      workOn('T001');
      expect(landBranch('T001')).toEqual({ ok: true });
      expect(head()).toBe('main');
      expect(git('log -1 --pretty=%s').trim()).toBe('feat: work for the ticket');
      expect(git('log -1 --pretty=%P').trim().split(/\s+/).filter(Boolean)).toHaveLength(1);
    });
  });

  test('a moved mainline is interference: classified, never resolved', () => {
    inRepo(() => {
      workOn('T001');
      git('checkout -q main');
      fs.writeFileSync('README.md', 'someone moved mainline\n');
      git('add -A && git commit -qm "external"');
      const landed = landBranch('T001');
      expect(landed.ok).toBe(false);
      if (!landed.ok) expect(landed.dirty).toBe(false);
      expect(git('log -1 --pretty=%s').trim()).toBe('external'); // mainline untouched
    });
  });
});

describe('resuming onto a surviving branch', () => {
  test('attach checks the branch back out; null when there is nothing to attach', () => {
    inRepo(() => {
      workOn('T001');
      discardCheckout();
      expect(attachBranch('T001')).toEqual({ branch: 'ailoop/T001' });
      expect(head()).toBe('ailoop/T001');
      expect(fs.readFileSync('src/a.ts', 'utf8')).toContain("a = 'T001'");
      expect(attachBranch('T404')).toBeNull();
    });
  });
});

describe('the mainline sha', () => {
  test('reads the recorded ref, never HEAD', () => {
    inRepo(() => {
      workOn('T001'); // HEAD is now a commit ahead of main, on the ticket branch
      expect(mainSha()).toBe(git('rev-parse main').trim());
      expect(mainSha()).not.toBe(git('rev-parse HEAD').trim());
    });
  });
});
