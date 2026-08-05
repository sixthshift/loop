// The fast-tier amendment: an upsert whose admission is decided by running the
// proposed command, not by which anomaly proposed it. Each case drives the real
// `amendFastChecks` against a scratch campaign with real (trivial) commands, and
// reads back both halves of the record — the tier in force, and the journal
// entries that have to survive into the post-mortem.

import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { amendFastChecks, classifyFastCheckEdit } from './fastcheck.ts';
import { backlog } from './backlog.ts';
import { journalEntries } from './journal.ts';
import { withScratchCampaign, withScratchCampaignAsync } from './scratch-campaign.ts';
import type { Check } from './agents/schemas.ts';

const UNIT: Check = { name: 'unit', cmd: 'true' };

// The amendment measures candidates in the checkout and refuses to do so off
// the recorded mainline, so its scratch campaign needs a real (if unborn) ref.
const gitInit = () => execSync('git init -q -b main .', { stdio: 'pipe' });

type Amended = { fastChecks: Check[]; kinds: { kind: string; body: string }[]; returned: string };

const amend = async (inForce: Check[], proposed: Check[]): Promise<Amended> => {
  let out!: Amended;
  await withScratchCampaignAsync({ backlog: { tickets: [], fastChecks: inForce, mainline: 'main' }, journal: [] }, async () => {
    gitInit();
    const returned = await amendFastChecks(proposed, { by: 'recover(stalled)', note: 'why' });
    out = {
      fastChecks: backlog().fastChecks ?? [],
      kinds: journalEntries().map(e => ({ kind: e.kind, body: e.body ?? '' })),
      returned,
    };
  });
  return out;
};

describe('classifyFastCheckEdit', () => {
  test('a name not in force is an addition; a changed cmd under a live name is a replacement', () => {
    withScratchCampaign({ backlog: { tickets: [], fastChecks: [UNIT] } }, () => {
      const edit = classifyFastCheckEdit([{ name: 'lint', cmd: 'bun run lint' }, { name: 'unit', cmd: 'bun test src' }]);
      expect(edit.added).toEqual([{ name: 'lint', cmd: 'bun run lint' }]);
      expect(edit.replaced).toEqual([{ check: { name: 'unit', cmd: 'bun test src' }, was: 'true' }]);
    });
  });

  test('re-proposing the tier in force is neither act', () => {
    withScratchCampaign({ backlog: { tickets: [], fastChecks: [UNIT] } }, () => {
      expect(classifyFastCheckEdit([UNIT])).toEqual({ added: [], replaced: [] });
    });
  });
});

describe('a proposal that runs green on the mainline', () => {
  test('an addition lands with no audit entry of its own', async () => {
    const out = await amend([UNIT], [{ name: 'types', cmd: 'true' }]);
    expect(out.fastChecks).toEqual([UNIT, { name: 'types', cmd: 'true' }]);
    expect(out.kinds.map(k => k.kind)).toEqual(['fast-check-amendment']);
    expect(out.returned).toBe('fast tier [+types]');
  });

  test('a replacement lands under fast-check-replaced carrying the command it displaced', async () => {
    const out = await amend([UNIT], [{ name: 'unit', cmd: 'true # in the worktree this time' }]);
    expect(out.fastChecks).toEqual([{ name: 'unit', cmd: 'true # in the worktree this time' }]);
    const audit = out.kinds.find(k => k.kind === 'fast-check-replaced');
    expect(audit?.body).toContain('was: true');
    expect(audit?.body).toContain('now: true # in the worktree this time');
    // The behavioral state is durable before its audit annotation.
    expect(out.kinds.map(k => k.kind)).toEqual(['fast-check-amendment', 'fast-check-replaced']);
    expect(out.returned).toBe('fast tier [~unit]');
  });
});

describe('a proposal that does not run green on the mainline', () => {
  test('is refused whatever proposed it, and the tier is untouched', async () => {
    const out = await amend([UNIT], [{ name: 'unit', cmd: 'exit 3' }]);
    expect(out.fastChecks).toEqual([UNIT]);
    const refusal = out.kinds.find(k => k.kind === 'fast-check-refused');
    expect(refusal?.body).toContain('exited 3');
    expect(out.kinds.map(k => k.kind)).toEqual(['fast-check-refused']);
    expect(out.returned).toBe('fast tier [✗unit]');
  });

  test('one red proposal does not hold back a green one in the same amendment', async () => {
    const out = await amend([UNIT], [{ name: 'types', cmd: 'true' }, { name: 'unit', cmd: 'false' }]);
    expect(out.fastChecks).toEqual([UNIT, { name: 'types', cmd: 'true' }]);
    expect(out.kinds.map(k => k.kind)).toEqual(['fast-check-refused', 'fast-check-amendment']);
    expect(out.returned).toBe('fast tier [+types, ✗unit]');
  });
});

describe('an amendment proposed off the mainline', () => {
  test('is refused before anything is measured — the tier is untouched', async () => {
    await withScratchCampaignAsync({ backlog: { tickets: [], fastChecks: [UNIT], mainline: 'main' }, journal: [] }, async () => {
      gitInit();
      execSync('git checkout -q -b ailoop/T001', { stdio: 'pipe' });
      await expect(amendFastChecks([{ name: 'types', cmd: 'true' }], { by: 'recover', note: 'why' }))
        .rejects.toThrow(/HEAD is on ailoop\/T001, not main/);
      expect(backlog().fastChecks).toEqual([UNIT]);
      expect(journalEntries()).toEqual([]);
    });
  });
});

describe('a no-op proposal', () => {
  test('costs neither a measurement nor a record', async () => {
    const out = await amend([UNIT], [UNIT]);
    expect(out.fastChecks).toEqual([UNIT]);
    expect(out.kinds).toEqual([]);
    expect(out.returned).toBe('fast tier [no change]');
  });
});
