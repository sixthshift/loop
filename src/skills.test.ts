// The skills installer writes into $HOME, so its refusals matter more than its
// happy path: the one it exists to prevent is writing "into" a ~/.claude/skills
// that is really a symlink into somebody's dotfiles repository, which would commit
// files to a repo the user never pointed us at.
//
// Driven through the real CLI in a child process with HOME redirected, because the
// destination paths resolve from the environment at module load — the same reason
// mechanics.test.ts shells out.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dir, 'index.ts');
const REPO_SKILLS = path.resolve(import.meta.dir, '..', 'skills');

const loop = (home: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

describe('loop skills install', () => {
  test('symlinks both skills from a source checkout, and re-running is idempotent', () => {
    withHome(home => {
      expect(loop(home, 'skills', 'install').status).toBe(0);

      // Live edits are the whole point of the source mode: the installed path must
      // BE the checkout, not a copy of it.
      const installed = path.join(home, '.claude/skills/ailoop');
      expect(fs.lstatSync(installed).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(installed)).toBe(fs.realpathSync(path.join(REPO_SKILLS, 'ailoop')));
      expect(fs.existsSync(path.join(installed, 'SKILL.md'))).toBe(true);

      // aispec travels to Codex; ailoop cannot — it spawns Agent-tool subagents.
      expect(fs.existsSync(path.join(home, '.agents/skills/aispec'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.agents/skills/ailoop'))).toBe(false);

      expect(loop(home, 'skills', 'install').status).toBe(0);
    });
  });

  test('refuses a symlinked skills root rather than writing through it', () => {
    withHome(home => {
      const elsewhere = path.join(home, 'dotfiles-checkout');
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(home, '.claude/skills'));

      const refused = loop(home, 'skills', 'install');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('is a symlink to');
      // The point of the refusal: nothing reached the other repository.
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
  });

  test('refuses a skill directory it did not install, unless forced', () => {
    withHome(home => {
      const mine = path.join(home, '.claude/skills/ailoop');
      fs.mkdirSync(mine, { recursive: true });
      fs.writeFileSync(path.join(mine, 'SKILL.md'), 'hand-written, not loop\n');

      const refused = loop(home, 'skills', 'install');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('was not installed by loop');
      expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toContain('hand-written');

      expect(loop(home, 'skills', 'install', '--force').status).toBe(0);
      expect(fs.lstatSync(mine).isSymbolicLink()).toBe(true);
    });
  });

  test('uninstall removes what loop owns and leaves everything else', () => {
    withHome(home => {
      loop(home, 'skills', 'install');
      const handmade = path.join(home, '.claude/skills/handmade');
      fs.mkdirSync(handmade, { recursive: true });
      fs.writeFileSync(path.join(handmade, 'SKILL.md'), 'mine\n');

      expect(loop(home, 'skills', 'uninstall').status).toBe(0);
      expect(fs.readdirSync(path.join(home, '.claude/skills'))).toEqual(['handmade']);
      expect(fs.existsSync(path.join(home, '.agents/skills/aispec'))).toBe(false);
    });
  });
});

function withHome(body: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-skills-'));
  try {
    body(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
