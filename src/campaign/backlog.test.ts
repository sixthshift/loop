// The sole writer's campaign-level fields — the facts the coordinator used to
// reconstruct by folding the journal, and now reads straight off the backlog.
// Each case drives the real `backlogWrite` against a scratch campaign and reads
// the resulting file back.

import { describe, expect, test } from 'bun:test';
import { backlog, backlogWrite } from './backlog.ts';
import type { Backlog } from './backlog.ts';
import { buildTicket, withScratchCampaign } from './scratch-campaign.ts';

const afterWrites = (seed: Partial<Backlog>, writes: () => void): Backlog => {
  let out!: Backlog;
  withScratchCampaign({ backlog: seed }, () => { writes(); out = backlog(); });
  return out;
};

const GATE = [{ name: 'e2e', cmd: 'bun test:e2e' }];

describe('gate-run', () => {
  test('a run stamps the verdict and the counts it measured', () => {
    const b = afterWrites({
      tickets: [
        buildTicket({ id: 'T001', status: 'closed' }),
        buildTicket({ id: 'T002', status: 'closed' }),
        buildTicket({ id: 'T003', status: 'open' }),
      ],
      gate: GATE,
    }, () => { backlogWrite(['gate-run', 'green', '--note', 'gate green: [e2e]']); });
    expect(b.gateState?.lastRun).toEqual({ result: 'green', tickets: 3, closed: 2 });
  });

  test('a later run overwrites the earlier verdict', () => {
    const b = afterWrites({ tickets: [], gate: GATE }, () => {
      backlogWrite(['gate-run', 'green', '--note', 'gate green: [e2e]']);
      backlogWrite(['gate-run', 'red', '--note', 'gate red: [e2e]']);
    });
    expect(b.gateState?.lastRun?.result).toBe('red');
  });

  test('only green and red are verdicts, and the note is mandatory', () => {
    withScratchCampaign({ backlog: { tickets: [], gate: GATE } }, () => {
      expect(() => backlogWrite(['gate-run', 'amber', '--note', 'n'])).toThrow(/green \| red/);
      expect(() => backlogWrite(['gate-run', 'green'])).toThrow(/requires --note/);
    });
  });
});

describe('the gate park latch', () => {
  test('gate-park records the reason the human has to answer', () => {
    const b = afterWrites({ tickets: [], gate: GATE }, () => {
      backlogWrite(['gate-park', '--reason', 'e2e red against a spec clause nobody owns']);
    });
    expect(b.gateState?.parked?.reason).toBe('e2e red against a spec clause nobody owns');
  });

  test('gate-park without a reason is refused — the reason IS the record', () => {
    withScratchCampaign({ backlog: { tickets: [] } }, () => {
      expect(() => backlogWrite(['gate-park'])).toThrow(/requires --reason/);
    });
  });

  test('an amendment releases the latch — the human edited the gate and resumed', () => {
    const b = afterWrites({ tickets: [], gate: [] }, () => {
      backlogWrite(['gate-park', '--reason', 'recover out of jurisdiction']);
      backlogWrite(['gate', '-', '--note', 'narrowed to the suite it should own'], GATE);
    });
    expect(b.gateState?.parked).toBeUndefined();
    expect(b.gate).toEqual(GATE);
  });

  test('a park after an amendment latches again', () => {
    const b = afterWrites({ tickets: [], gate: [] }, () => {
      backlogWrite(['gate-park', '--reason', 'first']);
      backlogWrite(['gate', '-', '--note', 'amended'], GATE);
      backlogWrite(['gate-park', '--reason', 'second']);
    });
    expect(b.gateState?.parked?.reason).toBe('second');
  });

  test('a gate run never touches the latch — only an amendment answers a park', () => {
    const b = afterWrites({ tickets: [], gate: GATE }, () => {
      backlogWrite(['gate-park', '--reason', 'held for a human']);
      backlogWrite(['gate-run', 'green', '--note', 'gate green: [e2e]']);
    });
    expect(b.gateState?.parked?.reason).toBe('held for a human');
  });
});

describe('the dispatch base sha', () => {
  const dispatched = (id: string, sha: string) =>
    backlogWrite(['set-status', id, 'in-flight', '--note', `dispatched on loop/${id}`, '--base-sha', sha]);

  test('a dispatch stamps the base its worktree was cut from', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] },
      () => { dispatched('T001', 'abc1234'); });
    expect(b.tickets[0]!.baseSha).toBe('abc1234');
  });

  test('the in-flight round trip a check amendment makes preserves it', () => {
    // reviewReturn's amend-typo path: in-flight → open (to patch the checks) →
    // in-flight, all against the same worktree. Nothing was re-cut, so the
    // original base must survive to be re-verified against.
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] }, () => {
      dispatched('T001', 'abc1234');
      backlogWrite(['set-status', 'T001', 'open', '--note', 'check amendment']);
      backlogWrite(['set-status', 'T001', 'in-flight', '--note', 're-verify after typo amendment']);
    });
    expect(b.tickets[0]!.baseSha).toBe('abc1234');
  });

  test('a re-dispatch overwrites it — the new worktree has a new base', () => {
    const b = afterWrites({ tickets: [buildTicket({ id: 'T001' })] }, () => {
      dispatched('T001', 'abc1234');
      backlogWrite(['set-status', 'T001', 'open', '--note', 'attempt failed']);
      dispatched('T001', 'def5678');
    });
    expect(b.tickets[0]!.baseSha).toBe('def5678');
  });

  test('only a dispatch carries a base — any other transition is refused', () => {
    withScratchCampaign({ backlog: { tickets: [buildTicket({ id: 'T001' })] } }, () => {
      expect(() => backlogWrite(['set-status', 'T001', 'parked', '--base-sha', 'abc1234']))
        .toThrow(/only legal on → in-flight/);
      // …and the refusal is total: the illegal write left no residue.
      expect(backlog().tickets[0]!.baseSha).toBeUndefined();
    });
  });
});
