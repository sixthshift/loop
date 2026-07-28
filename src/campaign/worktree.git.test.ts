// What a dispatched worker actually receives, against real repositories.
//
// Both properties under test here were learned from a campaign that burned every
// dispatch on them: a worktree cut inside the repository is swept up by the
// primary checkout's own tooling and silently resolves dependencies out of it,
// and a worktree with no dependency tree reds every ticket's baseline identically.
// Neither shows up in a unit test of a pure fold — the fault lives in git's and
// the filesystem's behaviour — so each case builds a throwaway repository, cuts a
// real worktree, and reads back what a worker would find.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { createWorktree, attachWorktree, removeWorktree, worktreesRoot, mergeBranch } from './worktree.ts';
import { provision } from './provision.ts';

const git = (cmd: string, cwd?: string) => execSync(`git ${cmd}`, { stdio: 'pipe', cwd }).toString();

// A repository shaped like the one the incident happened in: tracked source, an
// ignored installed dependency tree at the root, a second one nested under a
// workspace package, and an ignored build output that is NOT a dependency tree.
function inRepo(body: (repo: string) => void): void {
  const entered = enter();
  try {
    body(entered.repo);
  } finally {
    leave(entered);
  }
}

// The same repository for a case that awaits — provisioning is async, so that it
// cannot hold the coordinator's event loop while it copies.
async function inRepoAsync(body: (repo: string) => Promise<void>): Promise<void> {
  const entered = enter();
  try {
    await body(entered.repo);
  } finally {
    leave(entered);
  }
}

function enter(): { repo: string; dir: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-worktree-'));
  const repo = fs.realpathSync(dir); // macOS hands out /var → /private/var symlinks; git reports the real path
  const cwd = process.cwd();
  process.chdir(repo);

  git('init -q .');
  git('config user.email loop@test && git config user.name loop');
  fs.writeFileSync('.gitignore', 'node_modules/\ndist/\n.ailoop/\n');
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync('src/a.ts', 'export const a = 1;\n');
  fs.mkdirSync('packages/ui/src', { recursive: true });
  fs.writeFileSync('packages/ui/src/b.ts', 'export const b = 2;\n');
  git('add -A && git commit -qm base');

  write('node_modules/dep/index.js', 'module.exports = 1;\n');
  write('packages/ui/node_modules/dep/index.js', 'module.exports = 2;\n');
  write('dist/bundle.js', 'built\n');

  return { repo, dir, cwd };
}

function leave({ dir, cwd }: { repo: string; dir: string; cwd: string }): void {
  fs.rmSync(worktreesRoot(), { recursive: true, force: true });
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, content);
}

describe('where a worker checkout lives', () => {
  test('outside the repository, so nothing scanning the repo can reach it', () => {
    inRepo(repo => {
      const { dir } = createWorktree('T001');
      expect(fs.existsSync(path.join(dir, 'src/a.ts'))).toBe(true); // it IS a checkout
      expect(dir.startsWith(repo + path.sep)).toBe(false);
      // The repository the gate and every root-run check measures is untouched:
      // no worktree directory to collect duplicate suites from, and no new
      // ignored path either.
      expect(git('status --porcelain --untracked-files=all')).toBe('');
      expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.gitignore', 'dist', 'node_modules', 'packages', 'src']);
    });
  });
});

describe('a checkout nested inside another repository', () => {
  test('falls back to the state directory rather than dirtying the outer repo', () => {
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-outer-')));
    const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-state-')));
    const cwd = process.cwd();
    const priorHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      git('init -q .', outer);
      const inner = path.join(outer, 'inner');
      fs.mkdirSync(inner);
      git('init -q .', inner);
      process.chdir(inner);

      const root = worktreesRoot();
      // A sibling of `inner` is inside `outer` — the same fault one level up.
      expect(root.startsWith(outer + path.sep)).toBe(false);
      expect(root.startsWith(state + path.sep)).toBe(true);
      expect(root).toContain('inner-'); // keyed per checkout: a shared root must not be shared state
    } finally {
      if (priorHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = priorHome;
      process.chdir(cwd);
      fs.rmSync(outer, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('provisioning', () => {
  test('brings every ignored dependency tree, workspace-nested ones included', async () => {
    await inRepoAsync(async () => {
      const { dir } = createWorktree('T001');
      const summary = await provision('T001', dir);
      expect(fs.readFileSync(path.join(dir, 'node_modules/dep/index.js'), 'utf8')).toBe('module.exports = 1;\n');
      expect(fs.readFileSync(path.join(dir, 'packages/ui/node_modules/dep/index.js'), 'utf8')).toBe('module.exports = 2;\n');
      expect(summary).toContain('node_modules');
      expect(summary).toContain('packages/ui/node_modules');
    });
  });

  test('leaves an ignored non-dependency directory behind', async () => {
    await inRepoAsync(async () => {
      // `dist/` is ignored and present, and copying it would hand the worker a
      // stale build of the code it is about to change.
      const { dir } = createWorktree('T001');
      const summary = await provision('T001', dir);
      expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
      expect(summary).not.toContain('dist');
    });
  });

  test('leaves the worktree clean, which is what verify refuses over', async () => {
    await inRepoAsync(async () => {
      // The load-bearing consequence of taking the list from git's ignore rules:
      // everything provisioned is ignored in the worktree too, so verify's
      // dirty-tree refusal cannot see it. A tree copied in by name could.
      const { dir } = createWorktree('T001');
      await provision('T001', dir);
      expect(git('status --porcelain --untracked-files=all', dir)).toBe('');
    });
  });

  test('a resumed worktree can be provisioned like a dispatched one', async () => {
    await inRepoAsync(async () => {
      const { dir } = createWorktree('T001');
      fs.rmSync(dir, { recursive: true, force: true }); // the session died; the branch survives
      const attached = attachWorktree('T001');
      expect(attached).not.toBeNull();
      await provision('T001', attached!.dir);
      expect(fs.existsSync(path.join(attached!.dir, 'node_modules/dep/index.js'))).toBe(true);
    });
  });

  // Not tested here: that a long copy never holds the coordinator's event loop.
  // The property is real and is why every shell call in provision.ts is async, but
  // it is not observable on this filesystem — a copy-on-write clone finishes in
  // milliseconds whatever the tree's size, so no timing assertion can tell a
  // blocking copy from a yielding one. A tick-counting test written here passed
  // against a deliberately synchronous copy, which is why there isn't one.

  test('removing the worktree takes the provisioned tree with it', async () => {
    await inRepoAsync(async () => {
      const { dir } = createWorktree('T001');
      await provision('T001', dir);
      removeWorktree('T001');
      expect(fs.existsSync(dir)).toBe(false); // hundreds of megabytes per ticket, so a leak here compounds
    });
  });
});

describe('landing a ticket', () => {
  // One commit's worth of work on the ticket's branch, as a worker leaves it.
  const workOn = (id: string): void => {
    const { dir } = createWorktree(id);
    fs.writeFileSync(path.join(dir, 'src/a.ts'), `export const a = ${id};\n`);
    git('add -A && git commit -qm "feat: work for the ticket"', dir);
  };

  const parents = () => git('log -1 --pretty=%P').trim().split(/\s+/).filter(Boolean);

  test('fast-forwards when mainline has not moved — no merge commit', () => {
    inRepo(() => {
      workOn('T001');
      expect(mergeBranch('T001')).toEqual({ ok: true });
      expect(parents()).toHaveLength(1);
      expect(git('log -1 --pretty=%s').trim()).toBe('feat: work for the ticket');
    });
  });

  test('fast-forwards even where the repository configures merge.ff = false', () => {
    inRepo(() => {
      // Ambient config must not shape the campaign's history — the whole reason
      // mergeBranch passes --ff explicitly.
      git('config merge.ff false');
      workOn('T001');
      expect(mergeBranch('T001')).toEqual({ ok: true });
      expect(parents()).toHaveLength(1);
    });
  });

  test('still merges when mainline has genuinely diverged', () => {
    inRepo(() => {
      workOn('T001');
      fs.writeFileSync('README.md', 'landed something else first\n');
      git('add -A && git commit -qm "other work"'); // mainline moved past T001's base
      expect(mergeBranch('T001')).toEqual({ ok: true });
      expect(parents()).toHaveLength(2);
      expect(git('log -1 --pretty=%s').trim()).toBe('loop: merge T001');
    });
  });
});
