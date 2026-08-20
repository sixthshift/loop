// Bisecting a red gate over the closed tickets' surviving branches. Two
// properties matter and neither is the search result: that HEAD comes back to
// mainline however the run ends, and that the search is monotone — a check that
// broke at the third landing must not be reported against the first branch that
// happened to be tested.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { bisect } from './bisect.ts';

const git = (cmd: string) => execSync(`git ${cmd}`, { stdio: 'pipe' }).toString();
const head = () => git('symbolic-ref --short HEAD').trim();

// A campaign whose tickets landed in order, each leaving its branch behind.
// `breakAt` is the ticket whose landing first makes `marker` say "bad".
async function inCampaign(ids: string[], breakAt: string | null, body: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-bisect-'));
  const repo = fs.realpathSync(dir);
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    git('init -q -b main .');
    git('config user.email loop@test && git config user.name loop');
    fs.writeFileSync('.gitignore', '.ailoop/\n');
    fs.writeFileSync('marker', 'good\n');
    git('add -A && git commit -qm base');
    fs.mkdirSync('.ailoop/campaign', { recursive: true });

    let broken = false;
    for (const id of ids) {
      git(`checkout -q -b ailoop/${id}`);
      if (id === breakAt) broken = true;
      fs.writeFileSync('marker', broken ? 'bad\n' : 'good\n');
      fs.writeFileSync(`${id}.txt`, `work for ${id}\n`); // every landing must be a real diff
      git(`add -A && git commit -qm "work for ${id}"`);
      git('checkout -q main');
      git(`merge -q --ff-only ailoop/${id}`);
    }

    fs.writeFileSync('.ailoop/campaign/backlog.json', JSON.stringify({
      project: 't', mainline: 'main',
      tickets: ids.map(id => ({ id, status: 'closed' })),
    }));
    fs.writeFileSync('.ailoop/campaign/journal.jsonl',
      ids.map((id, i) => JSON.stringify({ seq: i + 1, ts: `2026-01-0${i + 1}T00:00:00.000Z`, kind: 'close', subject: id, body: 'closed' })).join('\n') + '\n');
    await body();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CHECK = 'grep -q good marker';

describe('bisect', () => {
  test('it names the earliest landing that was already red', async () => {
    await inCampaign(['T001', 'T002', 'T003', 'T004', 'T005'], 'T003', async () => {
      const r = await bisect({ cmd: CHECK });
      expect(r.firstRed).toBe('T003');
      expect(r.lastGreen).toBe('T002');
    });
  });

  test('it searches rather than scans', async () => {
    await inCampaign(['T001', 'T002', 'T003', 'T004', 'T005', 'T006', 'T007', 'T008'], 'T006', async () => {
      const r = await bisect({ cmd: CHECK });
      expect(r.firstRed).toBe('T006');
      // 8 candidates: a linear scan would run 6 before finding it.
      expect(r.tested.length).toBeLessThanOrEqual(4);
    });
  });

  test('red from the very first landing reports no last-green', async () => {
    await inCampaign(['T001', 'T002', 'T003'], 'T001', async () => {
      const r = await bisect({ cmd: CHECK });
      expect(r.firstRed).toBe('T001');
      expect(r.lastGreen).toBe(null);
    });
  });

  // Green everywhere is a finding, not a failure: no single branch carries the
  // fault, so it is the merge or the command.
  test('green at every landing reports no culprit', async () => {
    await inCampaign(['T001', 'T002', 'T003'], null, async () => {
      const r = await bisect({ cmd: CHECK });
      expect(r.firstRed).toBe(null);
      expect(r.lastGreen).toBe('T003');
    });
  });

  test('HEAD returns to mainline after a run', async () => {
    await inCampaign(['T001', 'T002', 'T003'], 'T002', async () => {
      await bisect({ cmd: CHECK });
      expect(head()).toBe('main');
    });
  });

  // The obligation this verb exists to make mechanical: a throw mid-search must
  // not strand the checkout on a ticket branch, where every later measurement
  // would silently describe the wrong tree.
  test('HEAD returns to mainline even when the search throws', async () => {
    await inCampaign(['T001', 'T002', 'T003'], 'T002', async () => {
      fs.rmSync('.ailoop/campaign/backlog.json');
      await expect(bisect({ cmd: CHECK })).rejects.toThrow();
      expect(head()).toBe('main');
    });
  });

  test('it refuses to start anywhere but mainline', async () => {
    await inCampaign(['T001', 'T002'], 'T002', async () => {
      git('checkout -q ailoop/T001');
      await expect(bisect({ cmd: CHECK })).rejects.toThrow(/HEAD is on ailoop\/T001/);
    });
  });

  test('a reaped branch is skipped, not treated as green', async () => {
    await inCampaign(['T001', 'T002', 'T003'], 'T003', async () => {
      git('branch -D ailoop/T002');
      const r = await bisect({ cmd: CHECK });
      expect(r.skipped).toEqual(['T002']);
      expect(r.firstRed).toBe('T003');
    });
  });
});
