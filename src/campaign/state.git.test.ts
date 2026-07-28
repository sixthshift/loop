// The coordinator lock is a repository boundary, so exercise it through a real
// Git directory and a second process. A same-process mock cannot prove that
// exclusive creation refuses a competing command.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './state.ts';

const stateModule = pathToFileURL(path.join(import.meta.dir, 'state.ts')).href;

describe('the repository coordinator lock', () => {
  test('exists before campaign state and refuses a competing process', () => {
    withRepository(dir => {
      expect(fs.existsSync('.ailoop/campaign')).toBe(false);
      acquireLock();
      expect(fs.readFileSync('.git/ailoop/coordinator.pid', 'utf8')).toBe(String(process.pid));
      expect(fs.existsSync('.ailoop/campaign')).toBe(false);

      const child = spawnSync(process.execPath, ['-e', `
        import { acquireLock, LockHeldError } from ${JSON.stringify(stateModule)};
        try {
          acquireLock();
          process.exit(0);
        } catch (error) {
          if (error instanceof LockHeldError) process.exit(23);
          throw error;
        }
      `], { cwd: dir, encoding: 'utf8' });
      expect(child.status).toBe(23);
    });
  });

  test('reclaims a dead pid before taking ownership', () => {
    withRepository(() => {
      fs.mkdirSync('.git/ailoop', { recursive: true });
      fs.writeFileSync('.git/ailoop/coordinator.pid', '999999999');
      acquireLock();
      expect(fs.readFileSync('.git/ailoop/coordinator.pid', 'utf8')).toBe(String(process.pid));
    });
  });
});

function withRepository(body: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-lock-'));
  const cwd = process.cwd();
  spawnSync('git', ['init', '-q', dir]);
  process.chdir(dir);
  try {
    body(dir);
  } finally {
    releaseLock();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
