// The fields the dashboard reads and no mechanic branches on — and the writer
// rules that keep them from lying, which is the only reason they are in the
// authoritative snapshot rather than in a display's memory.
//
// A phase's failure mode is not a wrong colour. It is `merging` sitting on a
// ticket that walled back to open forty minutes ago, which reads as live work and
// hides the exact condition it was added to expose: an in-flight ticket with no
// worker behind it (invariant 1), silently holding its modules against everything
// that shares a directory with it.

import { describe, expect, test } from 'bun:test';
import { backlog, backlogWrite } from './backlog.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';

const ticketOf = (id: string) => backlog().tickets.find(t => t.id === id)!;

// A ticket mid-dispatch, which is the only state a phase is legal in.
const dispatched = (body: () => void) =>
  withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
    backlogWrite(['set-status', 'T001', 'in-flight', '--base-sha', 'abc1234']);
    body();
  });

describe('the phase stamp', () => {
  test('a dispatch stamps one, because a dispatch has an obvious phase', () => {
    dispatched(() => {
      expect(ticketOf('T001').phase?.name).toBe('dispatched');
    });
  });

  test('it moves without a status change — which is why it is not an `update`', () => {
    dispatched(() => {
      backlogWrite(['phase', 'T001', 'verifying']);
      expect(ticketOf('T001').phase?.name).toBe('verifying');
      expect(ticketOf('T001').status).toBe('in-flight');
    });
  });

  test('the writer refuses a phase it does not define', () => {
    dispatched(() => {
      expect(() => backlogWrite(['phase', 'T001', 'thinking-hard'])).toThrow(/phase must be one of/);
      expect(ticketOf('T001').phase?.name).toBe('dispatched');
    });
  });

  test('a settled ticket has no phase, so it cannot carry a stale one', () => {
    dispatched(() => {
      backlogWrite(['phase', 'T001', 'merging']);
      backlogWrite(['set-status', 'T001', 'open', '--note', 'judge said retry']);
      expect(ticketOf('T001').phase).toBeUndefined();
    });
  });

  test('a ticket that is not in flight cannot be given one', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['phase', 'T001', 'verifying'])).toThrow(/only an in-flight ticket has a phase/);
    });
  });

  // The re-stamps that put a ticket back in-flight mid-settle (a typo amendment,
  // a re-verify) carry no base sha because no worktree was re-cut. They also have
  // no obvious phase — whatever they are about to do, the caller says so — and
  // inventing `dispatched` for them would report a fresh dispatch that never
  // happened.
  test('a re-stamp without a dispatch invents nothing', () => {
    dispatched(() => {
      backlogWrite(['set-status', 'T001', 'open', '--note', 'check amendment']);
      backlogWrite(['set-status', 'T001', 'in-flight']);
      expect(ticketOf('T001').phase).toBeUndefined();
    });
  });
});

describe('the dispatch stamp', () => {
  test('it records the rung the live attempt is spending', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      backlogWrite(['set-status', 'T001', 'in-flight', '--base-sha', 'abc1234',
        '--model', 'codex-gpt-5.6-sol', '--rung', '2']);
      expect(ticketOf('T001').dispatch).toMatchObject({ model: 'codex-gpt-5.6-sol', rung: 2 });
    });
  });

  test('a rung with no model is refused — a position on a chain needs the chain', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['set-status', 'T001', 'in-flight', '--base-sha', 'a', '--rung', '2']))
        .toThrow(/needs the --model/);
    });
  });

  test('dispatch flags are refused on a transition that is not a dispatch', () => {
    dispatched(() => {
      expect(() => backlogWrite(['set-status', 'T001', 'open', '--model', 'claude-opus']))
        .toThrow(/only legal on → in-flight/);
    });
  });

  // Unlike the phase, this survives the ticket settling: what rung a parked
  // ticket was last dispatched at is exactly what a human deciding its fate wants,
  // and the next dispatch overwrites it.
  test('it outlives the ticket going back to open, as baseSha does', () => {
    dispatched(() => {
      backlogWrite(['set-status', 'T001', 'open', '--note', 'retry']);
      expect(ticketOf('T001').baseSha).toBe('abc1234');
    });
  });
});
