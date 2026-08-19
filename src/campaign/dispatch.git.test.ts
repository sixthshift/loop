// One dispatch, one call. The cases that matter are the ones where collapsing
// seven steps could hide something the coordinator used to see between them: a
// vacuous check, an exhausted ladder, a ticket that was never dispatchable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { dispatch } from './dispatch.ts';
import { backlog } from './backlog.ts';
import type { Check } from './agents/schemas.ts';

const git = (cmd: string) => execSync(`git ${cmd}`, { stdio: 'pipe' }).toString();

async function inRepo(
  over: { acceptanceChecks?: Check[]; satisfies?: string[]; status?: string; attempts?: unknown[] },
  body: () => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-dispatch-'));
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
      project: 't', coordinator: 'skill', mainline: 'main',
      fastChecks: [{ name: 'unit', cmd: 'true' }],
      outOfScope: ['a login UI appears'],
      requirements: [{ id: 'R1', clause: 'the session survives a restart' }],
      tickets: [{
        id: 'T001', title: 'persist the session', modules: ['src/auth'], origin: 'spec',
        context: 'ctx', acceptance: 'a cookie survives a restart',
        acceptanceChecks: over.acceptanceChecks ?? [{ name: 'survives', cmd: 'false' }],
        satisfies: over.satisfies ?? ['R1'],
        status: over.status ?? 'open',
        ...(over.attempts ? { attempts: over.attempts } : {}),
      }],
    }));
    await body();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('dispatch', () => {
  test('one call cuts the branch, stamps in-flight, and renders the prompt', async () => {
    await inRepo({}, async () => {
      const p = await dispatch({ id: 'T001', context: 'the auth module owns the cookie' });
      expect(p.branch).toBe('ailoop/T001');
      expect(git('symbolic-ref --short HEAD').trim()).toBe('ailoop/T001');
      const t = backlog().tickets[0]!;
      expect(t.status).toBe('in-flight');
      expect(t.baseSha).toBe(p.baseSha);
      expect(t.dispatch?.rung).toBe(1);
    });
  });

  test('the prompt carries what no verb could derive and what every verb can', async () => {
    await inRepo({}, async () => {
      const p = await dispatch({ id: 'T001', context: 'the auth module owns the cookie' });
      expect(p.prompt).toContain('the auth module owns the cookie');   // the caller's judgement
      expect(p.prompt).toContain('a login UI appears');                 // outOfScope, verbatim
      expect(p.prompt).toContain('R1: the session survives a restart'); // the claimed clause
      expect(p.prompt).toContain('src/auth');
      expect(p.prompt).toContain('(first attempt)');
      expect(p.prompt).toContain('(none — every acceptance check was red on the base)');
    });
  });

  // The check that already passes is the finding the old seven-step sequence
  // surfaced between steps; collapsing them must not swallow it.
  test('a vacuous acceptance check stops the dispatch rather than riding along', async () => {
    await inRepo({ acceptanceChecks: [{ name: 'already-green', cmd: 'true' }] }, async () => {
      await expect(dispatch({ id: 'T001', context: 'c' })).rejects.toThrow(/already pass on the base/);
      expect(backlog().tickets[0]!.status).toBe('open');
      expect(git('symbolic-ref --short HEAD').trim()).toBe('main');
    });
  });

  test('--accept-vacuous proceeds and tells the worker which checks cannot confirm it', async () => {
    await inRepo({ acceptanceChecks: [{ name: 'already-green', cmd: 'true' }] }, async () => {
      const p = await dispatch({ id: 'T001', context: 'c', acceptVacuous: true });
      expect(p.vet.vacuous).toEqual(['already-green']);
      expect(p.prompt).toContain('- already-green');
    });
  });

  // The ladder rung is arithmetic over merit attempts, and a machine fault is
  // not one — a ticket whose engine died twice still starts at the bottom.
  test('the rung climbs with merit attempts and ignores infra ones', async () => {
    const attempt = (failed: string, infra = false) => ({ n: 1, failed: [failed], hypothesis: 'h', ...(infra ? { infra: true } : {}) });
    await inRepo({ attempts: [attempt('typecheck')] }, async () => {
      expect((await dispatch({ id: 'T001', context: 'c' })).rung.n).toBe(2);
    });
    await inRepo({ attempts: [attempt('dead-engine', true), attempt('worker-channel', true)] }, async () => {
      expect((await dispatch({ id: 'T001', context: 'c' })).rung.n).toBe(1);
    });
  });

  test('a ticket that is not open never reaches the checkout', async () => {
    await inRepo({ status: 'parked' }, async () => {
      await expect(dispatch({ id: 'T001', context: 'c' })).rejects.toThrow(/is parked/);
      expect(git('symbolic-ref --short HEAD').trim()).toBe('main');
    });
  });

  test('context is required — it is the one field a verb cannot write', async () => {
    await inRepo({}, async () => {
      await expect(dispatch({ id: 'T001', context: '   ' })).rejects.toThrow(/--context is required/);
    });
  });

  test('a ticket claiming no requirement says so rather than shipping a hole', async () => {
    await inRepo({ satisfies: [] }, async () => {
      const p = await dispatch({ id: 'T001', context: 'c' });
      expect(p.prompt).toContain('(this ticket claims no requirement directly)');
    });
  });
});
