// The producer stamp is the whole separation between the two coordinator seats.
// Neither can hold the other's lock — the skill's seat is a conversation, not a
// process — so if this guard is wrong, two coordinators drive one backlog with
// nothing between them and the diverged tickets corrupt each other silently.
//
// Exercised through the real CLI in a child process, because the guard lives at
// the argv boundary: the same modules called in-process are loop's own drive and
// must stay unguarded.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dir, 'index.ts');

const loop = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('the coordinator seat stamp', () => {
  test('a mechanics verb refuses a campaign the CLI seat started', () => {
    withRepository(dir => {
      expect(loop(dir, 'backlog', 'init', '--project', 'p').status).toBe(0);
      expect(seatOf(dir)).toBe('cli'); // the default: this program is the writer

      const refused = loop(dir, 'backlog', 'note', '--kind', 'k', '--subject', 's', '--body', 'b');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('coordinator: cli');
      // Refused before the write, not after: the journal must not carry an event
      // the guard was supposed to prevent.
      expect(fs.existsSync(path.join(dir, '.ailoop/campaign/journal.jsonl'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, '.ailoop/campaign/journal.jsonl'), 'utf8')).not.toContain('"kind":"k"');
    });
  });

  test('the CLI seat refuses to resume a campaign the skill started', () => {
    withRepository(dir => {
      expect(loop(dir, 'backlog', 'init', '--project', 'p', '--coordinator', 'skill').status).toBe(0);
      expect(seatOf(dir)).toBe('skill');

      const refused = loop(dir, 'resume');
      expect(refused.status).toBe(2); // paused, state intact — never a crash
      expect(refused.stderr).toContain('coordinator: skill');
    });
  });

  test('a skill campaign accepts the mechanics verbs, and reads stay open to both seats', () => {
    withRepository(dir => {
      loop(dir, 'backlog', 'init', '--project', 'p', '--coordinator', 'skill');
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

const seatOf = (dir: string): string =>
  JSON.parse(fs.readFileSync(path.join(dir, '.ailoop/campaign/backlog.json'), 'utf8')).coordinator;

function withRepository(body: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seat-'));
  spawnSync('git', ['init', '-q', dir]);
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
