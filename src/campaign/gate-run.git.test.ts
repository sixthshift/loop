// The campaign gate's own run, against real repositories. What matters here is
// not that a passing command passes — it is the two guards, because both failures
// are silent: a gate run from a ticket branch and a gate run over uncommitted
// work both produce a verdict that reads exactly like a correct one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { runGate } from './gate-run.ts';
import { backlog } from './backlog.ts';
import { journalEntries } from './journal.ts';
import type { Check } from './agents/schemas.ts';

const git = (cmd: string) => execSync(`git ${cmd}`, { stdio: 'pipe' }).toString();

async function inRepo(gate: Check[], body: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-gate-'));
  const repo = fs.realpathSync(dir);
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    git('init -q -b main .');
    git('config user.email loop@test && git config user.name loop');
    fs.writeFileSync('.gitignore', '.ailoop/\n');
    git('add -A && git commit -qm base');
    fs.mkdirSync('.ailoop/campaign', { recursive: true });
    fs.writeFileSync('.ailoop/campaign/backlog.json', JSON.stringify({
      project: 't', mainline: 'main', gate, tickets: [],
    }));
    await body();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('running the campaign gate', () => {
  test('a green run stamps the verdict, the counts, and what it ran', async () => {
    await inRepo([{ name: 'e2e', cmd: 'true' }], async () => {
      const r = await runGate();
      expect(r.result).toBe('green');
      expect(r.failing).toEqual([]);
      expect(backlog().gateState?.lastRun?.result).toBe('green');
      // The note IS the stored evidence field, so it has to name the commands.
      expect(backlog().gateState?.lastRun?.evidence).toContain('ran [e2e]');
      expect(fs.readFileSync(r.evidence, 'utf8')).toContain('e2e — PASS');
    });
  });

  test('a red run names the failing checks rather than the verdict alone', async () => {
    await inRepo([{ name: 'e2e', cmd: 'true' }, { name: 'smoke', cmd: 'exit 2' }], async () => {
      const r = await runGate();
      expect(r.result).toBe('red');
      expect(r.failing).toEqual(['smoke']);
      expect(r.runs.find(x => x.name === 'smoke')?.status).toBe(2);
      expect(journalEntries().at(-1)!.kind).toBe('gate-red');
    });
  });

  // A settled campaign leaves HEAD on mainline; a stale in-flight does not. The
  // run would succeed and describe the wrong tree, and nothing downstream could
  // tell afterwards which tree it measured.
  test('it refuses to measure from a ticket branch', async () => {
    await inRepo([{ name: 'e2e', cmd: 'true' }], async () => {
      git('checkout -q -b ailoop/T001');
      await expect(runGate()).rejects.toThrow(/HEAD is on ailoop\/T001, not main/);
      expect(backlog().gateState?.lastRun).toBeUndefined();
    });
  });

  test('it refuses a dirty tree — the gate measures what landed, not what is lying around', async () => {
    await inRepo([{ name: 'e2e', cmd: 'true' }], async () => {
      fs.writeFileSync('unreviewed.ts', 'export const x = 1;\n');
      await expect(runGate()).rejects.toThrow(/checkout is dirty/);
      expect(backlog().gateState?.lastRun).toBeUndefined();
    });
  });

  test('campaign state in the tree is not litter — it shares the checkout by design', async () => {
    await inRepo([{ name: 'e2e', cmd: 'true' }], async () => {
      fs.writeFileSync('.ailoop/campaign/scratch.json', '{}');
      expect((await runGate()).result).toBe('green');
    });
  });

  // Kickoff may legitimately return no gate commands. Refusing would strand
  // those campaigns, so the verdict is green and says outright that it measured
  // nothing — a documented nothing rather than a "green" implying a suite ran.
  test('an empty gate greens by vacancy, and the record says so', async () => {
    await inRepo([], async () => {
      const r = await runGate();
      expect(r.result).toBe('green');
      expect(r.note).toContain('NO gate commands');
      expect(backlog().gateState?.lastRun?.evidence).toContain('NO gate commands');
    });
  });
});
