// `gateParked` is a backlog read — a latch the sole writer sets when recover
// gave up inside its jurisdiction and clears when the gate is amended. The read
// is one field; the transitions that set and clear it are the writer's, and are
// pinned in backlog.test.ts.

import { describe, expect, test } from 'bun:test';
import { gateParked } from './escalate.ts';
import type { GateState } from './backlog.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';

const onScratch = (gateState: GateState | undefined) => {
  let parked!: boolean;
  withScratchCampaign({ backlog: { tickets: [], gateState } }, () => { parked = gateParked(); });
  return parked;
};

describe('gateParked', () => {
  test('a campaign with no gate state parks nothing', () => {
    expect(onScratch(undefined)).toBe(false);
    expect(onScratch({})).toBe(false);
  });

  test('a red run is not a park — recover gets its turn before the human does', () => {
    expect(onScratch({
      lastRun: { result: 'red', tickets: 1, closed: 1, evidence: 'gate red' },
    })).toBe(false);
  });

  test('the latch reads off the recorded reason', () => {
    expect(onScratch({ parked: { reason: 'needs a human scope call' } })).toBe(true);
  });

  test('a parked ticket is not a parked gate', () => {
    let parked!: boolean;
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001', status: 'parked' })] } },
      () => { parked = gateParked(); });
    expect(parked).toBe(false);
  });
});
