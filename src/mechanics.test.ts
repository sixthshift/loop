// The producer stamp, which now guards one direction rather than two. It used to
// separate two live coordinator seats; the `cli` seat — this program's own drive
// loop — is gone, so what the stamp protects is a campaign that seat left in
// flight on someone's disk. Its worktrees answered to a process that no longer
// exists and its tickets were measured against arms these verbs don't have, so
// the verbs refuse it and say why instead of half-adopting it.
//
// Exercised through the real CLI in a child process, because the guard lives at
// the argv boundary.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dir, 'index.ts');

const loop = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('the coordinator seat stamp', () => {
  test('the seat a new campaign gets is the only one that still exists', () => {
    withRepository(dir => {
      expect(loop(dir, 'backlog', 'init', '--project', 'p').status).toBe(0);
      expect(seatOf(dir)).toBe('skill');
    });
  });

  // The campaign clock is stamped here rather than started by whatever renders it:
  // a skill-driven campaign spans many verb invocations and any number of
  // sessions, so a clock owned by the dashboard would measure the dashboard.
  test('init stamps the campaign clock into the snapshot', () => {
    withRepository(dir => {
      loop(dir, 'backlog', 'init', '--project', 'p');
      const startedAt = backlogOf(dir).startedAt;
      expect(startedAt).toBeString();
      expect(Date.parse(startedAt)).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  test('a mechanics verb refuses a campaign the removed CLI seat left behind', () => {
    withRepository(dir => {
      expect(loop(dir, 'backlog', 'init', '--project', 'p', '--coordinator', 'cli').status).toBe(0);
      expect(seatOf(dir)).toBe('cli');

      const refused = loop(dir, 'backlog', 'note', '--kind', 'k', '--subject', 's', '--body', 'b');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('coordinator: cli');
      // Refused before the write, not after: the journal must not carry an event
      // the guard was supposed to prevent.
      expect(fs.existsSync(path.join(dir, '.ailoop/campaign/journal.jsonl'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, '.ailoop/campaign/journal.jsonl'), 'utf8')).not.toContain('"kind":"k"');
    });
  });

  test('a skill campaign accepts the mechanics verbs, and a read keeps stdout clean', () => {
    withRepository(dir => {
      loop(dir, 'backlog', 'init', '--project', 'p');
      expect(loop(dir, 'backlog', 'note', '--kind', 'k', '--subject', 's', '--body', 'b').status).toBe(0);

      // stdout is a result payload: a caller parses it, so narration must not
      // land in the same stream.
      const read = loop(dir, 'frontier');
      expect(read.status).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ problems: [], dispatchable: [], complete: false });
    });
  });

  test('an unknown seat is refused rather than stored', () => {
    withRepository(dir => {
      const refused = loop(dir, 'backlog', 'init', '--project', 'p', '--coordinator', 'bogus');
      expect(refused.status).toBe(1);
      expect(fs.existsSync(path.join(dir, '.ailoop/campaign/backlog.json'))).toBe(false);
    });
  });
});

// The mainline record is both the ref the checkout lifecycle resolves against
// and the second compat stamp: a backlog without one was opened by a worktree
// release, whose state these verbs no longer know how to drive.
describe('the mainline stamp', () => {
  test('init resolves the campaign mainline from HEAD', () => {
    withRepository(dir => {
      expect(loop(dir, 'backlog', 'init', '--project', 'p').status).toBe(0);
      const head = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
      expect(backlogOf(dir).mainline).toBe(head);
    });
  });

  test('an explicit --mainline wins over HEAD', () => {
    withRepository(dir => {
      expect(loop(dir, 'backlog', 'init', '--project', 'p', '--mainline', 'trunk').status).toBe(0);
      expect(backlogOf(dir).mainline).toBe('trunk');
    });
  });

  test('a detached HEAD refuses init rather than recording nothing', () => {
    withRepository(dir => {
      spawnSync('bash', ['-lc',
        'git -c user.email=t@t -c user.name=t commit --allow-empty -qm x && git checkout -q --detach'],
        { cwd: dir });
      const refused = loop(dir, 'backlog', 'init', '--project', 'p');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('detached');
      expect(fs.existsSync(path.join(dir, '.ailoop/campaign/backlog.json'))).toBe(false);
    });
  });

  test('a mechanics verb refuses a campaign with no recorded mainline', () => {
    withRepository(dir => {
      loop(dir, 'backlog', 'init', '--project', 'p');
      const file = path.join(dir, '.ailoop/campaign/backlog.json');
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete b.mainline;
      fs.writeFileSync(file, JSON.stringify(b));

      const refused = loop(dir, 'backlog', 'note', '--kind', 'k', '--subject', 's', '--body', 'b');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('no mainline recorded');
    });
  });
});

const backlogOf = (dir: string): any =>
  JSON.parse(fs.readFileSync(path.join(dir, '.ailoop/campaign/backlog.json'), 'utf8'));

const seatOf = (dir: string): string => backlogOf(dir).coordinator;

function withRepository(body: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seat-'));
  spawnSync('git', ['init', '-q', dir]);
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
