// The pre-dispatch vacuity measurement. The whole claim is one bit per check —
// did it pass before the work existed — so the cases that matter are the ones
// where "passed" and "the ticket is fine" come apart.

import { describe, expect, test } from 'bun:test';
import { vet } from './vet.ts';
import { journalEntries } from './journal.ts';
import { buildTicket, withScratchCampaignAsync } from './scratch-campaign.ts';
import type { Check } from './agents/schemas.ts';

const onTicket = async (acceptanceChecks: Check[], body: (v: Awaited<ReturnType<typeof vet>>) => void) => {
  await withScratchCampaignAsync(
    { backlog: { tickets: [buildTicket({ id: 'T001', acceptanceChecks })] } },
    async () => { body(await vet({ id: 'T001', dir: '.' })); });
};

describe('vet', () => {
  test('a check that passes on the base is vacuous — it cannot be observing unbuilt work', async () => {
    await onTicket([{ name: 'already-green', cmd: 'true' }], v => {
      expect(v.vacuous).toEqual(['already-green']);
      expect(v.red).toEqual([]);
    });
  });

  test('a check that fails on the base is the healthy case', async () => {
    await onTicket([{ name: 'observes-the-clause', cmd: 'false' }], v => {
      expect(v.vacuous).toEqual([]);
      expect(v.red).toEqual(['observes-the-clause']);
    });
  });

  test('a mixed set names only the vacuous half', async () => {
    await onTicket([
      { name: 'real', cmd: 'false' },
      { name: 'vacuous', cmd: 'true' },
      { name: 'also-real', cmd: 'exit 3' },
    ], v => {
      expect(v.vacuous).toEqual(['vacuous']);
      expect(v.red).toEqual(['real', 'also-real']);
    });
  });

  // A command that cannot run is not green, so it is not the fault this verb
  // looks for — the ticket's build is what makes it runnable.
  test('a command that does not exist counts as red, not vacuous', async () => {
    await onTicket([{ name: 'not-yet-a-script', cmd: './scripts/assert-thing.sh' }], v => {
      expect(v.vacuous).toEqual([]);
      expect(v.red).toEqual(['not-yet-a-script']);
    });
  });

  test('a ticket with no acceptance checks reports nothing rather than refusing', async () => {
    await onTicket([], v => {
      expect(v.vacuous).toEqual([]);
      expect(v.runs).toEqual([]);
    });
  });

  // The clean result is evidence too: it is what makes the later green mean
  // something, so it is journaled rather than passed over in silence.
  test('the run is journaled either way, with the per-check statuses', async () => {
    await onTicket([{ name: 'a', cmd: 'true' }, { name: 'b', cmd: 'false' }], v => {
      const e = journalEntries().at(-1)!;
      expect(e.kind).toBe('vet');
      expect(e.subject).toBe('T001');
      expect((e.data as any).vacuous).toEqual(['a']);
      expect((e.data as any).runs.map((r: any) => r.status)).toEqual([0, 1]);
      expect(v.runs[0]!.ms).toBeGreaterThanOrEqual(0);
    });
  });
});
