// Sweep cadence is scheduler state, not an inference over audit history. These
// cases prove it survives resume as the difference between two backlog counts.

import { describe, expect, test } from 'bun:test';
import { sweepDue } from './sweep.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';

describe('sweepDue', () => {
  test('becomes due after five closes since the persistent baseline', () => {
    withScratchCampaign({ backlog: {
      tickets: Array.from({ length: 7 }, (_, index) =>
        buildTicket({ id: `T00${index + 1}`, status: 'closed' })),
      sweep: { closed: 2 },
    } }, () => {
      expect(sweepDue()).toBe(true);
    });
  });

  test('does not reconstruct cadence from journal events', () => {
    withScratchCampaign({
      backlog: {
        tickets: Array.from({ length: 4 }, (_, index) =>
          buildTicket({ id: `T00${index + 1}`, status: 'closed' })),
        sweep: { closed: 0 },
      },
      journal: Array.from({ length: 20 }, (_, index) => ({
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'close',
        subject: `audit-${index}`,
      })),
    }, () => {
      expect(sweepDue()).toBe(false);
    });
  });
});
