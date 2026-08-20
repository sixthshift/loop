// The three things a coordinator must not do by hand when it applies a recover
// verdict. `renumber` takes id allocation off the agent: proposed ids are
// placeholders, and any edge between two proposals has to follow its endpoints to
// the ids actually allocated. The budget decides whether a recover may be spent
// at all, keyed by what "the same anomaly" means for that kind. `gateAuthority`
// grants the right to replace a live gate command, by the anomaly rather than by
// the caller's word for it.

import { describe, expect, test } from 'bun:test';
import { priorRecoveries, recoverKey } from './recovery-budget.ts';
import { renumber } from './backlog.ts';
import { gateAuthority, GATE_RED } from './gate.ts';
import { buildEntry, buildTicket, withScratchCampaign } from './scratch-campaign.ts';
import type { Ticket } from './backlog.ts';

const onScratch = (existing: Ticket[], drafts: Ticket[]) => {
  let out!: ReturnType<typeof renumber>;
  withScratchCampaign({ backlog: { tickets: existing } }, () => { out = renumber(drafts); });
  return out.map(t => ({ id: t.id, depends_on: t.depends_on }));
};

describe('renumber', () => {
  test('an edge onto a sibling draft follows that sibling to its allocated id', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' }), buildTicket({ id: 'T002' })],
      [
        buildTicket({ id: 'T900' }),
        buildTicket({ id: 'T901', depends_on: ['T900'] }),
      ],
    );
    expect(out).toEqual([
      { id: 'T003', depends_on: [] },
      { id: 'T004', depends_on: ['T003'] },
    ]);
  });

  test('a chain of sibling edges survives, including a forward reference', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' })],
      [
        buildTicket({ id: 'A', depends_on: ['B'] }),   // points at a later sibling
        buildTicket({ id: 'B', depends_on: ['C'] }),
        buildTicket({ id: 'C' }),
      ],
    );
    expect(out).toEqual([
      { id: 'T002', depends_on: ['T003'] },
      { id: 'T003', depends_on: ['T004'] },
      { id: 'T004', depends_on: [] },
    ]);
  });

  test('an edge onto a ticket already in the backlog is left alone', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' })],
      [buildTicket({ id: 'T900', depends_on: ['T001'] })],
    );
    expect(out).toEqual([{ id: 'T002', depends_on: ['T001'] }]);
  });

  test('allocation fills gaps left by the ids in use', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' }), buildTicket({ id: 'T003' })],
      [buildTicket({ id: 'X' }), buildTicket({ id: 'Y' }), buildTicket({ id: 'Z' })],
    );
    expect(out.map(t => t.id)).toEqual(['T002', 'T004', 'T005']);
  });

  // A draft may propose an id that a live ticket already holds, which makes an
  // edge on that id ambiguous — sibling placeholder or real dependency? The remap
  // is consulted first, so the sibling reading wins and the edge becomes a
  // self-dependency the frontier will report as a cycle. Pinned as behaviour, not
  // endorsed: the alternative (prefer the live ticket) is equally guessable, and
  // only the agent's intent settles it.
  test('a draft proposing a live id resolves its own edge to itself', () => {
    const out = onScratch(
      [buildTicket({ id: 'T001' })],
      [buildTicket({ id: 'T001', depends_on: ['T001'] })],
    );
    expect(out).toEqual([{ id: 'T002', depends_on: ['T002'] }]);
  });

  test('nothing proposed allocates nothing', () => {
    expect(onScratch([buildTicket({ id: 'T001' })], [])).toEqual([]);
  });
});

// Recover is fresh-context every time, so it cannot notice that it has answered
// this exact anomaly before. The budget is the coordinator's memory on its
// behalf, and it is keyed by what "the same anomaly" means for that kind.
describe('the recover budget', () => {
  const recovered = (key: string, ...summaries: string[]) => ({
    [key]: { count: summaries.length, summaries },
  });

  const spent = (recoveries: NonNullable<import('./backlog.ts').Backlog['recoveries']>, key: string) => {
    let n = 0;
    withScratchCampaign({ backlog: { recoveries } }, () => { n = priorRecoveries(key).length; });
    return n;
  };

  test('a ticket-scoped anomaly is budgeted per ticket, so two tickets walling once each is not a pattern', () => {
    expect(recoverKey({ kind: 'attempt-wall', ticketId: 'T007' })).toBe('attempt-wall:T007');
    const recoveries = {
      ...recovered('attempt-wall:T007', 'fixed seven'),
      ...recovered('attempt-wall:T009', 'fixed nine'),
    };
    expect(spent(recoveries, 'attempt-wall:T007')).toBe(1);
  });

  test('a campaign-scoped anomaly is budgeted per campaign', () => {
    expect(recoverKey({ kind: GATE_RED, results: [] })).toBe(GATE_RED);
    expect(spent(recovered(GATE_RED, 'first fix', 'second fix'), GATE_RED)).toBe(2);
  });

  test('audit events do not reconstruct or change the persistent budget', () => {
    const journal = [
      buildEntry({ kind: 'parked', subject: 'campaign-gate', body: 'gave up' }),
      buildEntry({ kind: 'recover-refused', subject: 'gate', body: 'illegal action' }),
    ];
    let count = 0;
    withScratchCampaign({
      backlog: { recoveries: recovered(GATE_RED, 'one durable resolution') },
      journal,
    }, () => { count = priorRecoveries(GATE_RED).length; });
    expect(count).toBe(1);
  });

  test('the prior fixes are returned, not just counted — they are the evidence a park cites', () => {
    let summaries: string[] = [];
    withScratchCampaign({ backlog: {
      recoveries: recovered(GATE_RED, 'narrowed the e2e gate', 'narrowed it again'),
    } }, () => {
      summaries = priorRecoveries(GATE_RED);
    });
    expect(summaries).toEqual(['narrowed the e2e gate', 'narrowed it again']);
  });
});

// One recover seat serves every anomaly, but only one of them arrives holding a
// gate's own failure — and the kind naming it is a string the caller passes, so
// the gate's own stamped verdict has to agree before a live command may be
// replaced. Both halves are exercised here: the kind alone never suffices, and
// neither does a red gate under some other anomaly.
describe('gateAuthority', () => {
  const authority = (kind: string, lastRun?: 'green' | 'red') => {
    let out!: string;
    withScratchCampaign({ backlog: {
      gate: [{ name: 'e2e', cmd: 'bun test:e2e' }],
      ...(lastRun ? { gateState: { lastRun: { result: lastRun, tickets: 0, closed: 0, evidence: 'e' } } } : {}),
    } }, () => { out = gateAuthority(kind); });
    return out;
  };

  test("the gate's own red run may replace the command that produced it", () => {
    expect(authority(GATE_RED, 'red')).toBe('apply');
  });

  test('every other anomaly reaches recover without having run the gate, so it may only add', () => {
    for (const kind of ['stalled', 'attempt-wall', 'dirty-mainline', 'worker-blocked', 'coordinator-error']) {
      expect(authority(kind, 'red')).toBe('refuse');
    }
  });

  test('a kind that merely mentions the gate is not the gate anomaly', () => {
    expect(authority('gate-red', 'red')).toBe('refuse');
  });

  // The half a passed string cannot carry: with no red verdict on record there
  // is nothing for a replacement to answer, whatever the caller calls itself.
  test('the right kind over a green gate may not replace — there is no failure to answer', () => {
    expect(authority(GATE_RED, 'green')).toBe('refuse');
  });

  test('the right kind over a gate that never ran may not replace either', () => {
    expect(authority(GATE_RED)).toBe('refuse');
  });
});
