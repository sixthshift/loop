// `gateParked` is the other journal fold: a latch on the campaign gate, set when
// recover gave up inside its jurisdiction and cleared when the gate is amended.

import { describe, expect, test } from 'bun:test';
import { gateParked } from './escalate.ts';
import { buildEntry, withScratchCampaign } from './scratch-campaign.ts';
import type { JournalEntry } from './journal.ts';

const onScratch = (journal: JournalEntry[]) => {
  let parked!: boolean;
  withScratchCampaign({ backlog: { tickets: [] }, journal }, () => { parked = gateParked(); });
  return parked;
};

const entry = (seq: number, kind: string, subject = 'campaign-gate') =>
  buildEntry({ seq, kind, subject });

describe('gateParked', () => {
  test('an empty journal parks nothing', () => {
    expect(onScratch([])).toBe(false);
  });

  test('a park on the gate latches', () => {
    expect(onScratch([entry(1, 'gate-red'), entry(2, 'parked')])).toBe(true);
  });

  test('a later amendment clears the latch — the human edited the gate and resumed', () => {
    expect(onScratch([entry(1, 'parked'), entry(2, 'gate-amendment')])).toBe(false);
  });

  test('a park after an amendment latches again', () => {
    expect(onScratch([entry(1, 'parked'), entry(2, 'gate-amendment'), entry(3, 'parked')])).toBe(true);
  });

  test('a parked ticket is not a parked gate', () => {
    expect(onScratch([buildEntry({ seq: 1, kind: 'parked', subject: 'T001' })])).toBe(false);
  });

  test('a subject-less entry is not the gate', () => {
    expect(onScratch([buildEntry({ seq: 1, kind: 'parked' })])).toBe(false);
  });

  // The fold walks the file in order and never reads `seq`, so an out-of-order
  // journal resolves by position, not by stamp. Append-only writing makes the two
  // agree; this pins which one actually decides.
  test('the fold resolves by file order, not by seq', () => {
    expect(onScratch([entry(9, 'parked'), entry(2, 'gate-amendment')])).toBe(false);
    expect(onScratch([entry(9, 'gate-amendment'), entry(2, 'parked')])).toBe(true);
  });
});
