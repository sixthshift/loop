// `gateGreen` is a journal fold: the campaign gate is green only if it last ran
// green and no ticket has closed or been added since. Every case below is a
// scratch journal read through the real export.

import { describe, expect, test } from 'bun:test';
import { gateGreen } from './drive.ts';
import { buildEntry, withScratchCampaign } from './scratch-campaign.ts';
import type { JournalEntry } from './journal.ts';
import type { Check } from '../agent/schemas.ts';

const GATE: Check[] = [{ name: 'e2e', cmd: 'bun test:e2e' }];

const onScratch = (gate: Check[] | undefined, journal: JournalEntry[]) => {
  let green!: boolean;
  withScratchCampaign({ backlog: { tickets: [], gate }, journal }, () => { green = gateGreen(); });
  return green;
};

const entry = (seq: number | undefined, kind: string) =>
  buildEntry({ ...(seq === undefined ? {} : { seq }), kind, subject: 'campaign-gate' });

describe('gateGreen', () => {
  test('no slow suite configured collapses completion to the tickets draining', () => {
    expect(onScratch(undefined, [])).toBe(true);
    expect(onScratch([], [entry(1, 'add')])).toBe(true);
  });

  test('a configured gate that has never run is not green', () => {
    expect(onScratch(GATE, [])).toBe(false);
    expect(onScratch(GATE, [entry(1, 'add'), entry(2, 'close')])).toBe(false);
  });

  test('a green run with nothing after it is green', () => {
    expect(onScratch(GATE, [entry(1, 'add'), entry(2, 'campaign-gate-close')])).toBe(true);
  });

  test('a close after the green run reads stale', () => {
    expect(onScratch(GATE, [entry(1, 'campaign-gate-close'), entry(2, 'close')])).toBe(false);
  });

  test('an add after the green run reads stale — coverage work must re-clear the gate', () => {
    expect(onScratch(GATE, [entry(1, 'campaign-gate-close'), entry(2, 'add')])).toBe(false);
  });

  test('unrelated traffic after the green run does not stale it', () => {
    expect(onScratch(GATE, [
      entry(1, 'campaign-gate-close'),
      entry(2, 'attempt'), entry(3, 'status'), entry(4, 'sweep'), entry(5, 'recover'),
    ])).toBe(true);
  });

  test('the latest green run is the one that counts', () => {
    expect(onScratch(GATE, [
      entry(1, 'campaign-gate-close'),
      entry(2, 'add'),                       // staled the first run…
      entry(3, 'campaign-gate-close'),       // …and this one cleared it again
    ])).toBe(true);
  });

  // Known blindness, pinned rather than fixed: the staleness test compares
  // `seq ?? 0` against `seq ?? 0`, so an entry written without a seq can never
  // read as later than anything. `appendJournal` always stamps one, which makes
  // this reachable only from a hand-edited or foreign journal — where the failure
  // mode is a gate reported green over work it never ran.
  test('a seq-less close after a green run cannot stale it', () => {
    expect(onScratch(GATE, [entry(1, 'campaign-gate-close'), entry(undefined, 'close')])).toBe(true);
  });

  test('a seq-less green run is staled by nothing at all', () => {
    expect(onScratch(GATE, [entry(undefined, 'campaign-gate-close'), entry(undefined, 'add')])).toBe(true);
    // …not even by a seq'd add, which sorts as later everywhere else.
    expect(onScratch(GATE, [entry(undefined, 'campaign-gate-close'), entry(7, 'add')])).toBe(false);
  });
});
